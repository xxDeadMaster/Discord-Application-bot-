// Dashboard pages: Welcome (join/leave/boost + verification), Giveaways and Polls.
import express from 'express';
import {
  MAX_POLL_OPTIONS, cancelGiveaway, endGiveaway, endPoll, rerollGiveaway, startGiveaway, startPoll,
} from '../bot/giveaways.js';
import {
  PLACEHOLDERS, publishVerifyPanel, sendTestMessage, setWelcomeConfig,
} from '../bot/welcome.js';
import {
  deleteGiveaway, deletePoll, getGiveaway, getPoll, getWelcomeConfig, listGiveaways, listPolls, pollResults, updateWelcomeConfig,
} from '../db.js';
import { requireAdmin } from './auth.js';
import { ChannelType } from 'discord.js';
import {
  COUNTER_KINDS, countFor, counterName, detectCounters, normalizeName, setCounters, updateCounters,
} from '../bot/counters.js';
import {
  deleteRoleMenu, getRoleMenu, getSettings, listCounters, listRoleMenus, replaceCounters, saveRoleMenu, updateSettings,
} from '../db.js';
import {
  MAX_MENU_ITEMS, publishRoleMenu, unpublishRoleMenu,
} from '../bot/roleMenus.js';
import { cleanEmoji } from '../bot/ui.js';

export const communityRoutes = express.Router();

const flash = (req, type, text) => { req.session.flash = { type, text }; };
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const idParam = (req) => {
  const n = Number.parseInt(req.params.id, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
/** An ID from a form, only if it exists in the list; '' clears it. */
const pick = (v, list) => { const x = String(v ?? '').trim(); return x && list.some((i) => i.id === x) ? x : null; };

function requireManager(req, res, next) {
  if (res.locals.isManager) return next();
  res.status(403).render('error', { title: 'Managers only', message: 'Only managers (Manage Server, or the manager role in Settings) can do this.', user: res.locals.user });
}

const UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const MAX_MS = 30 * 86_400_000;
/** Duration from the form ("2" + "hours"). Returns ms, or null when invalid. */
function duration(value, unit) {
  const n = Number(value);
  const ms = n * (UNITS[unit] || 0);
  return Number.isFinite(ms) && ms >= 60_000 && ms <= MAX_MS ? ms : null;
}

/* ---------- Welcome ---------- */

communityRoutes.get('/welcome', requireAdmin, async (req, res) => {
  res.render('welcome', { title: 'Welcome', cfg: await getWelcomeConfig(), opts: res.locals.guildOpts(), placeholders: PLACEHOLDERS });
});

communityRoutes.post('/welcome', requireAdmin, async (req, res) => {
  const b = req.body;
  const opts = res.locals.guildOpts();
  const current = await getWelcomeConfig();
  const msg = (v, fallback) => clean(v, 1800) || fallback;
  const days = Number.parseInt(b.verify_min_account_days, 10);
  const patch = {
    join_enabled: b.join_enabled === 'on',
    join_channel_id: pick(b.join_channel_id, opts.textChannels),
    join_message: msg(b.join_message, current.join_message),
    join_card: b.join_card === 'on',
    join_dm_enabled: b.join_dm_enabled === 'on',
    join_dm_message: msg(b.join_dm_message, current.join_dm_message),
    auto_role_ids: toArray(b.auto_role_ids).filter((id) => opts.roles.some((r) => r.id === id)).slice(0, 5),
    rules_channel_id: pick(b.rules_channel_id, opts.textChannels),
    leave_enabled: b.leave_enabled === 'on',
    leave_channel_id: pick(b.leave_channel_id, opts.textChannels),
    leave_message: msg(b.leave_message, current.leave_message),
    leave_card: b.leave_card === 'on',
    boost_enabled: b.boost_enabled === 'on',
    boost_channel_id: pick(b.boost_channel_id, opts.textChannels),
    boost_message: msg(b.boost_message, current.boost_message),
    boost_card: b.boost_card === 'on',
    verify_channel_id: pick(b.verify_channel_id, opts.textChannels),
    verify_role_id: pick(b.verify_role_id, opts.roles),
    verify_title: clean(b.verify_title, 200) || 'Verify to join',
    verify_message: msg(b.verify_message, current.verify_message),
    verify_min_account_days: Number.isFinite(days) ? Math.min(Math.max(days, 0), 365) : 0,
    verify_log_channel_id: pick(b.verify_log_channel_id, opts.textChannels),
  };
  const saved = await updateWelcomeConfig(patch);
  setWelcomeConfig(saved);

  const warn = [];
  if (patch.join_enabled && !patch.join_channel_id) warn.push('pick a channel for welcome messages');
  if (patch.leave_enabled && !patch.leave_channel_id) warn.push('pick a channel for leave messages');
  if (patch.boost_enabled && !patch.boost_channel_id) warn.push('pick a channel for boost messages');
  const tab = ['join', 'leave', 'boost', 'verify'].includes(b.tab) ? b.tab : '';
  const back = `/welcome${tab ? `#${tab}` : ''}`;

  // "Save and send test" / "Save and post Verify panel" buttons
  const label = { join: 'welcome', leave: 'leave', boost: 'boost' };
  if (label[b.then_test]) {
    const r = await sendTestMessage(b.then_test, res.locals.user.id);
    flash(req, r.ok ? 'success' : 'error', r.ok ? `Saved, and a test ${label[b.then_test]} message for you was posted. Check the channel in Discord.` : `Saved, but the test failed: ${r.error}`);
    return res.redirect(back);
  }
  if (b.then_post === 'verify') {
    try {
      const r = await publishVerifyPanel();
      flash(req, 'success', `Saved, and the Verify panel was ${r.updated ? 'updated' : 'posted'} in Discord.`);
    } catch (err) {
      flash(req, 'error', `Saved, but the Verify panel could not be posted: ${err.message}`);
    }
    return res.redirect(back);
  }
  flash(req, warn.length ? 'error' : 'success', warn.length ? `Saved, but ${warn.join(', ')}.` : 'Welcome settings saved.');
  res.redirect(back);
});

communityRoutes.post('/welcome/test/:kind', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  if (!['join', 'leave', 'boost'].includes(kind)) return res.redirect('/welcome');
  const r = await sendTestMessage(kind, res.locals.user.id);
  const label = { join: 'welcome', leave: 'leave', boost: 'boost' }[kind];
  flash(req, r.ok ? 'success' : 'error', r.ok ? `Sent a test ${label} message for you. Check the channel in Discord.` : `Test failed: ${r.error} Save the channel first.`);
  res.redirect(`/welcome#${kind}`);
});

communityRoutes.post('/welcome/verify-panel', requireAdmin, async (req, res) => {
  try {
    const r = await publishVerifyPanel();
    flash(req, 'success', r.updated ? 'Verify panel updated in Discord.' : 'Verify panel posted in Discord.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect('/welcome#verify');
});

/* ---------- Giveaways ---------- */

communityRoutes.get('/giveaways', requireManager, async (req, res) => {
  res.render('giveaways', { title: 'Giveaways', giveaways: await listGiveaways(), opts: res.locals.guildOpts(), pingRoleId: (await getSettings()).giveaway_ping_role_id });
});

communityRoutes.post('/giveaways', requireManager, async (req, res) => {
  const b = req.body;
  const opts = res.locals.guildOpts();
  const prize = clean(b.prize, 200);
  const channelId = pick(b.channel_id, opts.textChannels);
  const ms = duration(b.duration_value, b.duration_unit);
  const winners = Number.parseInt(b.winner_count, 10);
  if (!prize) { flash(req, 'error', 'Type what the prize is.'); return res.redirect('/giveaways'); }
  if (!channelId) { flash(req, 'error', 'Pick a channel to post the giveaway in.'); return res.redirect('/giveaways'); }
  if (!ms) { flash(req, 'error', 'Pick how long it runs: at least 1 minute and at most 30 days.'); return res.redirect('/giveaways'); }
  if (!(winners >= 1 && winners <= 20)) { flash(req, 'error', 'Winners must be between 1 and 20.'); return res.redirect('/giveaways'); }
  try {
    const g = await startGiveaway({
      channelId, prize, description: clean(b.description, 1000), winnerCount: winners,
      requiredRoleId: pick(b.required_role_id, opts.roles), endsAt: new Date(Date.now() + ms),
      hostId: res.locals.user.id, hostTag: res.locals.user.name,
    });
    flash(req, 'success', `Giveaway #${g.id} for "${prize}" is live in Discord.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect('/giveaways');
});

communityRoutes.post('/giveaways/:id/:action', requireManager, async (req, res) => {
  const id = idParam(req);
  const g = id && await getGiveaway(id);
  if (!g) return res.redirect('/giveaways');
  const action = req.params.action;
  let r;
  if (action === 'end') r = await endGiveaway(id);
  else if (action === 'reroll') r = await rerollGiveaway(id, 1);
  else if (action === 'cancel') r = await cancelGiveaway(id);
  else if (action === 'delete') {
    if (g.status === 'active') await cancelGiveaway(id);
    await deleteGiveaway(id);
    r = { ok: true };
  } else return res.redirect('/giveaways');
  const done = { end: 'Giveaway ended and winners announced.', reroll: 'Picked a new winner and announced it.', cancel: 'Giveaway cancelled.', delete: 'Giveaway deleted from the dashboard.' }[action];
  flash(req, r.ok ? 'success' : 'error', r.ok ? done : r.error);
  res.redirect('/giveaways');
});

/* ---------- Polls ---------- */

communityRoutes.get('/polls', requireManager, async (req, res) => {
  const polls = await listPolls();
  for (const p of polls) p.results = await pollResults(p);
  res.render('polls', { title: 'Polls', polls, opts: res.locals.guildOpts(), maxOptions: MAX_POLL_OPTIONS });
});

communityRoutes.post('/polls', requireManager, async (req, res) => {
  const b = req.body;
  const opts = res.locals.guildOpts();
  const question = clean(b.question, 250);
  const options = toArray(b.options).map((o) => clean(o, 80)).filter(Boolean).slice(0, MAX_POLL_OPTIONS);
  const channelId = pick(b.channel_id, opts.textChannels);
  if (!question) { flash(req, 'error', 'Type the question.'); return res.redirect('/polls'); }
  if (options.length < 2) { flash(req, 'error', 'Add at least 2 options.'); return res.redirect('/polls'); }
  if (!channelId) { flash(req, 'error', 'Pick a channel to post the poll in.'); return res.redirect('/polls'); }
  let endsAt = null;
  if (b.duration_value) {
    const ms = duration(b.duration_value, b.duration_unit);
    if (!ms) { flash(req, 'error', 'Poll length must be at least 1 minute and at most 30 days, or leave it empty.'); return res.redirect('/polls'); }
    endsAt = new Date(Date.now() + ms);
  }
  try {
    const p = await startPoll({ channelId, question, options, multi: b.multi === 'on', endsAt, hostId: res.locals.user.id, hostTag: res.locals.user.name });
    flash(req, 'success', `Poll #${p.id} is live in Discord.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect('/polls');
});

communityRoutes.post('/polls/:id/:action', requireManager, async (req, res) => {
  const id = idParam(req);
  const p = id && await getPoll(id);
  if (!p) return res.redirect('/polls');
  let r;
  if (req.params.action === 'end') r = await endPoll(id);
  else if (req.params.action === 'delete') {
    if (p.status === 'active') await endPoll(id);
    await deletePoll(id);
    r = { ok: true };
  } else return res.redirect('/polls');
  flash(req, r.ok ? 'success' : 'error', r.ok ? (req.params.action === 'end' ? 'Poll closed. Final results are shown in Discord.' : 'Poll deleted from the dashboard.') : r.error);
  res.redirect('/polls');
});


/* ---------- Server stats (counter channels) ---------- */

/** Channels a counter can live in: text, announcement and voice channels. */
function counterChannels(guild) {
  const kinds = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice];
  return guild.channels.cache
    .filter((c) => kinds.includes(c.type))
    .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: `${c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice ? '🔊 ' : '#'}${c.name}`, parent: c.parent?.name || '', type: c.type }));
}

communityRoutes.get('/stats', requireAdmin, async (req, res) => {
  const guild = res.locals.guild;
  const saved = await listCounters();
  const suggested = saved.length ? [] : detectCounters(guild);
  const rows = (saved.length ? saved.map((c) => ({ channelId: c.channel_id, kind: c.kind, template: c.template })) : suggested);
  const channels = counterChannels(guild);
  const preview = rows.map((r) => {
    const ch = guild.channels.cache.get(r.channelId);
    return ch ? normalizeName(counterName({ kind: r.kind, template: r.template }, guild), ch.type) : '';
  });
  const counts = Object.fromEntries(Object.keys(COUNTER_KINDS).map((k) => [k, countFor(k, guild)]));
  res.render('stats', { title: 'Server stats', rows, preview, channels, kinds: COUNTER_KINDS, counts, isSuggestion: !saved.length && suggested.length > 0 });
});

communityRoutes.post('/stats', requireAdmin, async (req, res) => {
  const guild = res.locals.guild;
  const channels = counterChannels(guild);
  const ids = toArray(req.body.channel_id);
  const kinds = toArray(req.body.kind);
  const templates = toArray(req.body.template);
  const list = [];
  ids.forEach((id, i) => {
    const kind = kinds[i];
    if (!id || !channels.some((c) => c.id === id) || !COUNTER_KINDS[kind] || list.some((l) => l.channelId === id)) return;
    let template = clean(templates[i], 90) || COUNTER_KINDS[kind].template;
    if (!template.includes('{count}')) template = `${template} {count}`;
    list.push({ channelId: id, kind, template });
  });
  const saved = await replaceCounters(list.slice(0, 10));
  setCounters(saved);
  const renamed = await updateCounters({ force: true });
  flash(req, 'success', saved.length
    ? `Saved ${saved.length} counter${saved.length === 1 ? '' : 's'}. ${renamed ? `${renamed} channel${renamed === 1 ? ' was' : 's were'} updated now.` : 'Names were already up to date.'} They update every 10 minutes from now on.`
    : 'All counters removed. Orbit will not rename any channels.');
  res.redirect('/stats');
});


/* ---------- Giveaway ping role ---------- */

communityRoutes.post('/giveaways/ping-role', requireManager, async (req, res) => {
  const role = pick(req.body.giveaway_ping_role_id, res.locals.guildOpts().roles);
  await updateSettings({ giveaway_ping_role_id: role });
  flash(req, 'success', role ? 'Saved. That role is pinged whenever a new giveaway starts.' : 'Saved. New giveaways will not ping anyone.');
  res.redirect('/giveaways');
});

/* ---------- Role menus (role buttons) ---------- */

/** A starting menu for giveaway pings, filled in from the server's own channel and role names. */
function giveawayStarter(opts) {
  const channel = opts.textChannels.find((c) => /giveaway/i.test(c.name));
  const role = opts.roles.find((r) => /^@giveaways?$/i.test(r.name.trim())) || opts.roles.find((r) => /giveaway/i.test(r.name));
  return {
    title: '🎉 Giveaway Notifications',
    description: 'Get pinged whenever a new giveaway starts in the server.',
    channel_id: channel?.id || null,
    items: role ? [{ role_id: role.id, emoji: '🎁', label: 'Giveaway pings' }] : [],
  };
}

function menuFromForm(body, opts) {
  const roles = toArray(body.item_role);
  const emojis = toArray(body.item_emoji);
  const labels = toArray(body.item_label);
  const items = [];
  roles.forEach((roleId, i) => {
    if (!roleId || !opts.roles.some((r) => r.id === roleId) || items.some((it) => it.role_id === roleId)) return;
    items.push({ role_id: roleId, emoji: cleanEmoji(emojis[i]) || '', label: clean(labels[i], 80) });
  });
  return {
    title: clean(body.title, 200) || 'Pick your roles',
    description: clean(body.description, 1500),
    channelId: pick(body.channel_id, opts.textChannels),
    items: items.slice(0, MAX_MENU_ITEMS),
  };
}

communityRoutes.get('/role-menus', requireAdmin, async (req, res) => {
  const opts = res.locals.guildOpts();
  const menus = await listRoleMenus();
  res.render('role-menus', { title: 'Role buttons', menus, opts, starter: menus.length ? null : giveawayStarter(opts), maxItems: MAX_MENU_ITEMS });
});

async function saveAndMaybePost(req, res, id) {
  const opts = res.locals.guildOpts();
  const data = menuFromForm(req.body, opts);
  const menu = await saveRoleMenu({ id, ...data });
  if (!menu) return res.redirect('/role-menus');
  if (req.body.then_post) {
    try {
      const r = await publishRoleMenu(menu.id);
      flash(req, 'success', `Saved, and the menu was ${r.updated ? 'updated' : 'posted'} in Discord.`);
    } catch (err) {
      flash(req, 'error', `Saved, but it could not be posted: ${err.message}`);
    }
  } else {
    flash(req, 'success', menu.message_id ? 'Saved. Press "Save and post" to update the message in Discord.' : 'Saved.');
  }
  res.redirect(`/role-menus#menu-${menu.id}`);
}

communityRoutes.post('/role-menus', requireAdmin, (req, res) => saveAndMaybePost(req, res, null));
communityRoutes.post('/role-menus/:id', requireAdmin, async (req, res) => {
  const id = idParam(req);
  if (!id || !(await getRoleMenu(id))) return res.redirect('/role-menus');
  return saveAndMaybePost(req, res, id);
});
communityRoutes.post('/role-menus/:id/delete', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const menu = id && await getRoleMenu(id);
  if (menu) {
    await unpublishRoleMenu(menu);
    await deleteRoleMenu(id);
    flash(req, 'success', `Deleted "${menu.title}" and removed its message from Discord.`);
  }
  res.redirect('/role-menus');
});
