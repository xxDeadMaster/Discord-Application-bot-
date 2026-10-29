import express from 'express';
import { refreshTicketPanelQuietly } from '../bot/panels.js';
import { cleanEmoji } from '../bot/ui.js';

import { decideLoa, endLoa, isOnLoa, issueStrike, prettyDate, removeStrike, requestLoa, todayIn } from '../bot/staff.js';
import { DEFAULT_QUESTION, toggleClaim } from '../bot/tickets.js';
import { config } from '../config.js';
import {
  deleteModCase, getLoa, getModCase, getSettings, getTicketType, listLoas, listModCases, listStrikes, listTicketTypes, modCounts, query, updateSettings,
} from '../db.js';
import { ACTIONS, prettyMinutes } from '../bot/moderation.js';
import { loadTrap, publishTrap } from '../bot/spamTrap.js';
import { loadGifBlock } from '../bot/gifBlock.js';
import { presenceTracking, staffStatus } from '../bot/presence.js';
import { DAY_NAMES, staffMembers } from '../bot/staffReport.js';
import { guildOptions } from './routes.js';
import { activityScore, staffActivity } from '../stats.js';

export const staffRoutes = express.Router();

/** Emoji from a form: '' when cleared, the old value when the input isn't an emoji. */
const formEmoji = (value, old) => {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return cleanEmoji(v) ?? (old ?? '');
};

const flash = (req, type, text) => { req.session.flash = { type, text }; };
const idParam = (req) => {
  const n = Number.parseInt(req.params.id, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function requireManager(req, res, next) {
  if (res.locals.isManager) return next();
  res.status(403).render('error', { title: 'Managers only', message: 'Only managers (Manage Server, or the manager role in Settings) can do this.', user: res.locals.user });
}

/* ---------- Moderation (case history from /warn /timeout /kick /ban) ---------- */
const MOD_PAGE = 50;
staffRoutes.get('/moderation', requireManager, async (req, res) => {
  const action = Object.hasOwn(ACTIONS, String(req.query.action || '')) ? String(req.query.action) : null;
  const search = clean(req.query.q, 100) || null;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const [settings, cases, week] = await Promise.all([
    getSettings(),
    listModCases({ action, search, limit: MOD_PAGE + 1, offset: (page - 1) * MOD_PAGE }),
    modCounts(new Date(Date.now() - 7 * 24 * 3600 * 1000)),
  ]);
  res.render('moderation', {
    title: 'Moderation', cases: cases.slice(0, MOD_PAGE), hasMore: cases.length > MOD_PAGE, page, action, search, week,
    actions: ACTIONS, prettyMinutes, channels: guildOptions(res.locals.guild).textChannels, logChannelId: settings.mod_log_channel_id,
    trap: { channelId: settings.trap_channel_id, posted: Boolean(settings.trap_message_id), caught: settings.trap_caught || 0 },
    gif: { enabled: settings.gif_block_enabled, allowed: settings.gif_allowed_channel_ids || [] },
  });
});

staffRoutes.post('/moderation/log-channel', requireManager, async (req, res) => {
  const id = String(req.body.mod_log_channel_id || '').trim();
  const channels = guildOptions(res.locals.guild).textChannels;
  if (id && !channels.some((c) => c.id === id)) { flash(req, 'error', 'Pick a channel from the list.'); return res.redirect('/moderation'); }
  await updateSettings({ mod_log_channel_id: id || null });
  flash(req, 'success', id ? 'Mod log channel saved. Every /warn, /timeout, /kick and /ban will be posted there.' : 'Mod log turned off. Cases are still saved here.');
  res.redirect('/moderation');
});

staffRoutes.post('/moderation/gifs', requireManager, async (req, res) => {
  const channels = guildOptions(res.locals.guild).textChannels;
  const raw = req.body.gif_allowed_channel_ids;
  const ids = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).filter((id) => channels.some((c) => c.id === id));
  const enabled = req.body.gif_block_enabled === 'on';
  await updateSettings({ gif_block_enabled: enabled, gif_allowed_channel_ids: [...new Set(ids)] });
  await loadGifBlock();
  flash(req, 'success', enabled ? `GIF blocker is on.${ids.length ? ` GIFs are still allowed in ${ids.length} channel${ids.length === 1 ? '' : 's'}.` : ''}` : 'GIF blocker is off.');
  res.redirect('/moderation#gifs');
});

staffRoutes.post('/moderation/spam-trap', requireManager, async (req, res) => {
  const id = String(req.body.trap_channel_id || '').trim();
  const channels = guildOptions(res.locals.guild).textChannels;
  if (id && !channels.some((c) => c.id === id)) { flash(req, 'error', 'Pick a channel from the list.'); return res.redirect('/moderation'); }
  const settings = await getSettings();
  const moved = (id || null) !== (settings.trap_channel_id || null);
  await updateSettings({ trap_channel_id: id || null, ...(moved ? { trap_message_id: null } : {}) });
  await loadTrap();
  if (!id) { flash(req, 'success', 'Spam trap turned off.'); return res.redirect('/moderation'); }
  try {
    const r = await publishTrap();
    flash(req, 'success', `Spam trap is on. ${r.updated ? 'The warning message was updated.' : 'The warning message was posted.'} Anyone who isn't staff and posts there is removed.`);
  } catch (err) {
    flash(req, 'error', `Saved, but the warning couldn't be posted: ${err.message}`);
  }
  res.redirect('/moderation');
});

staffRoutes.post('/moderation/:id/delete', async (req, res) => {
  if (!res.locals.isAdmin) { flash(req, 'error', 'Only admins can delete cases.'); return res.redirect('/moderation'); }
  const c = await getModCase(idParam(req));
  if (!c) { flash(req, 'error', 'That case no longer exists.'); return res.redirect('/moderation'); }
  await deleteModCase(c.id);
  flash(req, 'success', `Deleted case #${c.id}. This doesn't undo the action in Discord.`);
  res.redirect('/moderation');
});

/* ---------- Activity ---------- */

const PERIODS = { '7': 7, '30': 30, all: null };

staffRoutes.get('/staff', async (req, res) => {
  const settings = await getSettings();
  const period = Object.hasOwn(PERIODS, req.query.period) ? req.query.period : '30';
  const since = PERIODS[period] ? new Date(Date.now() - PERIODS[period] * 86400000) : null;
  const activity = await staffActivity(since);
  const members = staffMembers(res.locals.guild, settings);
  const rows = new Map(members.map((m) => [m.id, { ...m, isStaffMember: true }]));
  for (const [id, a] of activity) if (!rows.has(id)) rows.set(id, { id, name: a.tag || id, tag: a.tag, isStaffMember: false });
  const today = todayIn(settings.timezone);
  const table = [...rows.values()].map((m) => {
    const a = activity.get(m.id) || { reviews: 0, accepted: 0, denied: 0, votes: 0, interviews: 0, claimed: 0, closed: 0, ratings: 0, ratingSum: 0, strikes: 0 };
    const loa = isOnLoa(m.id);
    return {
      ...m, ...a,
      online: m.isStaffMember ? staffStatus(res.locals.guild.members.cache.get(m.id)) : null,
      avgRating: a.ratings ? (a.ratingSum / a.ratings).toFixed(1) : null,
      score: activityScore(a),
      loa: loa ? (loa.onLeaveNow || (loa.start_date <= today && today <= loa.end_date) ? `On LOA until ${prettyDate(loa.end_date)}` : `LOA from ${prettyDate(loa.start_date)}`) : null,
    };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const totals = table.reduce((t, r) => ({ reviews: t.reviews + r.reviews, claimed: t.claimed + r.claimed, interviews: t.interviews + r.interviews, votes: t.votes + r.votes }), { reviews: 0, claimed: 0, interviews: 0, votes: 0 });
  res.render('staff', {
    title: 'Staff activity', table, period, totals, noStaffRole: !settings.staff_role_id,
    membersLoaded: res.locals.guild.members.cache.size > 1,
    presenceOn: presenceTracking(),
    report: { channelId: settings.staff_report_channel_id, day: settings.staff_report_day, hour: settings.staff_report_hour, last: settings.staff_report_last },
    dayNames: DAY_NAMES, textChannels: res.locals.guildOpts().textChannels, timezone: settings.timezone,
  });
});

/* ---------- Strikes ---------- */

staffRoutes.get('/strikes', requireManager, async (req, res) => {
  const settings = await getSettings();
  const strikes = await listStrikes();
  const activeByUser = new Map();
  for (const s of strikes) if (!s.revoked_at) activeByUser.set(s.user_id, (activeByUser.get(s.user_id) || 0) + 1);
  res.render('strikes', {
    title: 'Strikes', strikes, activeByUser, members: staffMembers(res.locals.guild, settings),
    rolesSet: (settings.strike_role_ids || []).filter(Boolean).length,
  });
});

staffRoutes.post('/strikes', requireManager, async (req, res) => {
  const member = res.locals.guild.members.cache.get(String(req.body.user_id || ''));
  if (!member) { flash(req, 'error', 'Pick a staff member.'); return res.redirect('/strikes'); }
  const r = await issueStrike({
    userId: member.id, userTag: member.user.tag || member.user.username, reason: clean(req.body.reason, 500),
    issuerId: res.locals.user.id, issuerTag: res.locals.user.username,
  });
  flash(req, r.ok ? 'success' : 'error', r.ok ? `Gave ${member.displayName} strike ${r.count}. ${r.notes.join(' ')}` : r.error);
  res.redirect('/strikes');
});

staffRoutes.post('/strikes/:id/remove', requireManager, async (req, res) => {
  const id = idParam(req);
  const r = id ? await removeStrike({ strikeId: id, byTag: res.locals.user.username }) : { ok: false, error: 'Not found.' };
  flash(req, r.ok ? 'success' : 'error', r.ok ? `Strike removed. ${r.strike.user_tag} now has ${r.count}. ${r.notes.join(' ')}` : r.error);
  res.redirect('/strikes');
});

/* ---------- LOA ---------- */

const getLoaOwner = async (id) => (id ? (await getLoa(id))?.user_id : null);

staffRoutes.get('/loa', async (req, res) => {
  const settings = await getSettings();
  const all = await listLoas();
  const today = todayIn(settings.timezone);
  const label = (l) => {
    if (l.status === 'approved') return l.start_date > today ? 'Upcoming' : 'On leave';
    if (l.status === 'ended') return 'Back';
    return l.status[0].toUpperCase() + l.status.slice(1);
  };
  const withLabel = all.map((l) => ({ ...l, label: label(l), from: prettyDate(l.start_date), until: prettyDate(l.end_date), early: l.status === 'ended' && l.ended_at && new Date(l.ended_at).toISOString().slice(0, 10) < l.end_date }));
  res.render('loa', {
    title: 'Leave of absence',
    pending: withLabel.filter((l) => l.status === 'pending'),
    current: withLabel.filter((l) => l.status === 'approved'),
    past: withLabel.filter((l) => !['pending', 'approved'].includes(l.status)).slice(0, 50),
    loaRoleSet: Boolean(settings.loa_role_id), loaChannelSet: Boolean(settings.loa_channel_id), today,
  });
});

staffRoutes.post('/loa', async (req, res) => {
  const r = await requestLoa({
    userId: res.locals.user.id, userTag: res.locals.user.username,
    start: req.body.start_date, end: req.body.end_date, reason: clean(req.body.reason, 500),
  });
  flash(req, r.ok ? 'success' : 'error', r.ok ? `You're on LOA from ${prettyDate(r.loa.start_date)} to ${prettyDate(r.loa.end_date)}. ${r.notes.join(' ')}` : r.error);
  res.redirect('/loa');
});

staffRoutes.post('/loa/:id/:action', async (req, res) => {
  // Managers can end anyone's LOA; staff can end their own ("I'm back early")
  const own = await getLoaOwner(idParam(req));
  if (!res.locals.isManager && !(req.params.action === 'end' && own === res.locals.user.id)) {
    return res.status(403).render('error', { title: 'Managers only', message: 'Only managers can change other people\'s LOA.', user: res.locals.user });
  }
  const id = idParam(req);
  const action = req.params.action;
  let r;
  if (!id) r = { ok: false, error: 'Not found.' };
  else if (action === 'approve' || action === 'deny') r = await decideLoa({ id, approve: action === 'approve', byId: res.locals.user.id, byTag: res.locals.user.username });
  else if (action === 'end') r = await endLoa({ id, byTag: res.locals.user.username });
  else r = { ok: false, error: 'Unknown action.' };
  const done = { approve: 'Approved', deny: 'Denied', end: r.loa?.status === 'cancelled' ? 'Cancelled' : 'Ended, and the LOA role was removed' }[action];
  flash(req, r.ok ? 'success' : 'error', r.ok ? `${done}. ${(r.notes || []).join(' ')}` : r.error);
  res.redirect('/loa');
});

/* ---------- Ticket types ---------- */

const DEFAULT_TYPES = [
  { name: 'Support', description: 'General help with the server or game', questions: [DEFAULT_QUESTION, 'What is your Roblox username?'] },
  { name: 'Report a Player', description: 'Report someone breaking the rules', questions: ['Who are you reporting? (Discord or Roblox username)', 'What did they do?', 'When did it happen?', 'Do you have proof? Paste links to screenshots or videos.'] },
  { name: 'Partnership', description: 'Partner your server or group with us', questions: ['What is your server or group called?', 'Invite link or group link', 'How many members do you have?', 'Why do you want to partner with BloxVerse?'] },
  { name: 'Punishment Appeal', description: 'Appeal a warning, mute or ban', questions: ['What punishment are you appealing (warning, mute, ban)?', 'When did you get it, and who gave it?', 'Why should it be removed?'] },
];

staffRoutes.get('/ticket-types', requireManager, async (req, res) => {
  const types = await listTicketTypes();
  const { rows: counts } = await query(
    'SELECT type_id, count(*)::int AS n FROM tickets WHERE guild_id = $1 AND type_id IS NOT NULL GROUP BY type_id', [config.guildId],
  );
  const used = Object.fromEntries(counts.map((c) => [c.type_id, c.n]));
  res.render('ticket-types', { title: 'Ticket types', types, used, opts: res.locals.guildOpts() });
});

staffRoutes.post('/ticket-types/defaults', requireManager, async (req, res) => {
  const existing = (await listTicketTypes()).map((t) => t.name.toLowerCase());
  let added = 0;
  for (const [i, t] of DEFAULT_TYPES.entries()) {
    if (existing.includes(t.name.toLowerCase())) continue;
    await query('INSERT INTO ticket_types (guild_id, name, description, questions, position) VALUES ($1, $2, $3, $4, $5)',
      [config.guildId, t.name, t.description, t.questions, existing.length + i]);
    added++;
  }
  await refreshTicketPanelQuietly();
  flash(req, 'success', added ? `Added ${added} ticket type${added === 1 ? '' : 's'}. Edit them below.` : 'Those ticket types already exist.');
  res.redirect('/ticket-types');
});

staffRoutes.post('/ticket-types', requireManager, async (req, res) => {
  const name = clean(req.body.name, 80);
  if (!name) { flash(req, 'error', 'Give the ticket type a name.'); return res.redirect('/ticket-types'); }
  const count = (await listTicketTypes()).length;
  if (count >= 25) { flash(req, 'error', 'Discord dropdowns hold at most 25 ticket types.'); return res.redirect('/ticket-types'); }
  await query('INSERT INTO ticket_types (guild_id, name, description, questions, position) VALUES ($1, $2, $3, $4, $5)',
    [config.guildId, name, clean(req.body.description, 100), [DEFAULT_QUESTION], count]);
  await refreshTicketPanelQuietly();
  flash(req, 'success', `Added "${name}".`);
  res.redirect('/ticket-types');
});

staffRoutes.post('/ticket-types/:id', requireManager, async (req, res) => {
  const id = idParam(req);
  const type = id && await getTicketType(id);
  if (!type) return res.redirect('/ticket-types');
  const opts = res.locals.guildOpts();
  const b = req.body;
  const pick = (v, list) => { const x = String(v || ''); return x && list.some((i) => i.id === x) ? x : null; };
  const questions = toArray(b.questions).map((q) => clean(q, 300)).filter(Boolean).slice(0, 5);
  const position = Number.parseInt(b.position, 10);
  await query(
    `UPDATE ticket_types SET name = $2, description = $3, questions = $4, staff_role_id = $5, category_id = $6, enabled = $7, position = $8, emoji = $9 WHERE id = $1`,
    [id, clean(b.name, 80) || type.name, clean(b.description, 100), questions.length ? questions : [DEFAULT_QUESTION],
      pick(b.staff_role_id, opts.roles), pick(b.category_id, opts.categories), b.enabled === 'on', Number.isFinite(position) ? position : type.position,
      formEmoji(b.emoji, type.emoji)],
  );
  await refreshTicketPanelQuietly();
  flash(req, 'success', `Saved "${clean(b.name, 80) || type.name}".`);
  res.redirect(`/ticket-types#type-${id}`);
});

staffRoutes.post('/ticket-types/:id/delete', requireManager, async (req, res) => {
  const id = idParam(req);
  const type = id && await getTicketType(id);
  if (type) {
    await query('DELETE FROM ticket_types WHERE id = $1', [id]);
    await refreshTicketPanelQuietly();
    flash(req, 'success', `Deleted "${type.name}". Past tickets keep their type name.`);
  }
  res.redirect('/ticket-types');
});

/* ---------- Claim from the dashboard ---------- */

staffRoutes.post('/tickets/:id/claim', async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/tickets');
  const r = await toggleClaim({ ticketId: id, userId: res.locals.user.id, userTag: res.locals.user.username, member: 'dashboard', settings: await getSettings() });
  flash(req, r.ok ? 'success' : 'error', r.ok ? (r.claimed ? 'You claimed this ticket.' : 'You unclaimed this ticket.') : r.error.replace(/<@\d+>/, 'Someone else'));
  res.redirect(`/tickets/${id}`);
});
