import { ChannelType } from 'discord.js';
import express from 'express';
import { castVote, decideSubmission, removeReviewMessages } from '../bot/applications.js';
import { startInterview } from '../bot/interviews.js';
import { prettyDate, todayIn } from '../bot/staff.js';
import { invalidatePanelCache, publishPanel, refreshApplyPanelQuietly } from '../bot/panels.js';
import { closeTicketFromDashboard, setTicketSettings, transcriptText } from '../bot/tickets.js';
import { MAX_QUESTIONS, cleanEmoji, inviteUrl } from '../bot/ui.js';
import { config } from '../config.js';
import {
  DAYS, DAY_NAMES, WEEK_ORDER, allTimezones, weeklyHours, describeSchedule, isCategoryOpen, isValidTimezone, parseLocalInput, parseTime, toLocalInput,
} from '../schedule.js';
import {
  dashboardCounts, deleteClosedTickets, findOpenLoa, listVotes, voteTally, deleteSubmissions, getCategory, getRole, getSettings, getSubmission, getTicket, listCategories, listQuestions,
  listRoles, listSnapshots, listSubmissions, listTicketMessages, listTickets, query, replaceQuestions, updateSettings,
} from '../db.js';
import { serverNumbers } from '../bot/counters.js';
import { requireAdmin } from './auth.js';

export const routes = express.Router();

/** Emoji from a form: '' when cleared (so defaults don't come back), the old value when the input isn't an emoji. */
const formEmoji = (value, old) => {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return cleanEmoji(v) ?? (old ?? '');
};
const LIMITS = { name: 80, description: 100, question: 500, panelTitle: 200, panelDescription: 2000, reason: 500 };

const flash = (req, type, text) => { req.session.flash = { type, text }; };
const idParam = (req) => {
  const n = Number.parseInt(req.params.id, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function guildOptions(guild) {
  const textChannels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: `#${c.name}${c.type === ChannelType.GuildAnnouncement ? ' 📢' : ''}`, parent: c.parent?.name || '' }));
  const categories = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name }));
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: `@${r.name}` }));
  return { textChannels, categories, roles };
}

/** Accepts an ID only if it exists in the server with the right kind; '' clears it. */
function pickId(value, list) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  return list.some((x) => x.id === v) ? v : undefined; // undefined = invalid
}

function nameOf(list, id) {
  return list.find((x) => x.id === id)?.name || null;
}

/* ---------- Overview ---------- */

routes.get('/', async (req, res) => {
  const guild = res.locals.guild;
  const me = res.locals.user.id;
  const [counts, settings, cats, snapshots, myLoa] = await Promise.all([
    dashboardCounts(), getSettings(), listCategories(), listSnapshots(30), findOpenLoa(me),
  ]);
  const checklist = [
    { done: Boolean(settings.staff_role_id), text: 'Pick a staff role', href: '/settings' },
    { done: Boolean(settings.apply_channel_id && settings.submissions_channel_id), text: 'Pick application + submissions channels', href: '/settings' },
    { done: cats.length > 0, text: 'Add an application category, roles and questions', href: '/applications' },
    { done: Boolean(settings.apply_panel_message_id), text: 'Post the application panel', href: '/settings#applications' },
    { done: Boolean(settings.ticket_channel_id && settings.ticket_panel_message_id), text: 'Pick a ticket channel and post the ticket panel', href: '/settings#tickets' },
  ];
  // One round trip for the to-do list and the "this week vs last week" numbers
  const { rows: [todo] } = await query(
    `SELECT
       (SELECT id FROM submissions WHERE guild_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1) AS oldest_pending,
       (SELECT count(*)::int FROM submissions s WHERE s.guild_id = $1 AND s.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM submission_votes v WHERE v.submission_id = s.id AND v.user_id = $2)) AS need_my_vote,
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1 AND status = 'open' AND claimed_by IS NULL) AS unclaimed,
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1 AND status = 'open' AND claimed_by = $2) AS my_tickets,
       (SELECT count(*)::int FROM submissions WHERE guild_id = $1 AND created_at >= now() - interval '7 days') AS apps_week,
       (SELECT count(*)::int FROM submissions WHERE guild_id = $1 AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS apps_prev,
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1 AND created_at >= now() - interval '7 days') AS tickets_week,
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1 AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS tickets_prev,
       (SELECT count(*)::int FROM mod_cases WHERE guild_id = $1 AND created_at >= now() - interval '7 days') AS mod_week,
       (SELECT count(*)::int FROM mod_cases WHERE guild_id = $1 AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS mod_prev,
       (SELECT count(*)::int FROM giveaways WHERE guild_id = $1 AND status = 'active') AS giveaways_active,
       (SELECT count(*)::int FROM giveaways WHERE guild_id = $1 AND status = 'ended' AND ended_at >= now() - interval '3 days') AS giveaways_ended,
       (SELECT count(*)::int FROM polls WHERE guild_id = $1 AND status = 'active') AS polls_active`,
    [config.guildId, me],
  );
  // Recent activity across the bot (newest first)
  const { rows: activity } = await query(
    `(SELECT 'application' AS kind, created_at AS at, user_tag AS who, role_name AS what, '/submissions/' || id AS href, status FROM submissions WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 8)
     UNION ALL (SELECT 'ticket', created_at, opener_tag, coalesce(type_name, 'Ticket') || ' #' || lpad(number::text, 4, '0'), '/tickets/' || id, status FROM tickets WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 8)
     UNION ALL (SELECT 'moderation', created_at, user_tag, action, '/moderation', mod_tag FROM mod_cases WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 8)
     UNION ALL (SELECT 'giveaway', created_at, coalesce(host_tag, ''), prize, '/giveaways', status FROM giveaways WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 4)
     UNION ALL (SELECT 'poll', created_at, coalesce(host_tag, ''), question, '/polls', status FROM polls WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 4)
     UNION ALL (SELECT 'loa', created_at, user_tag, to_char(start_date, 'Mon DD') || ' – ' || to_char(end_date, 'Mon DD'), '/loa', status FROM loa_requests WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 4)
     UNION ALL (SELECT 'strike', created_at, user_tag, reason, '/strikes', issued_by_tag FROM strikes WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 4)
     ORDER BY at DESC LIMIT 12`,
    [config.guildId],
  );
  // Members chart: daily snapshots once there are a few, otherwise daily activity for the last 14 days
  let chart;
  if (snapshots.length >= 3) {
    chart = { kind: 'members', label: 'Members', points: snapshots.map((s) => ({ day: s.day, value: s.members })) };
  } else {
    const { rows } = await query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
         (SELECT count(*)::int FROM submissions WHERE guild_id = $1 AND created_at::date = d)
         + (SELECT count(*)::int FROM tickets WHERE guild_id = $1 AND created_at::date = d)
         + (SELECT count(*)::int FROM mod_cases WHERE guild_id = $1 AND created_at::date = d) AS value
       FROM generate_series(current_date - 13, current_date, interval '1 day') AS d`,
      [config.guildId],
    );
    chart = { kind: 'activity', label: 'Applications, tickets and mod actions per day', points: rows };
  }
  const numbers = serverNumbers(guild);
  const weekAgo = snapshots.length ? snapshots[Math.max(0, snapshots.length - 8)] : null;
  res.render('overview', {
    title: 'Overview', counts, checklist, inviteUrl: inviteUrl(), todo, activity, chart, numbers,
    memberChange: weekAgo && snapshots.length > 1 ? numbers.members - weekAgo.members : null,
    myLoa: myLoa ? { ...myLoa, from: prettyDate(myLoa.start_date), until: prettyDate(myLoa.end_date), started: myLoa.start_date <= todayIn(settings.timezone) } : null,
  });
});

/** Review queue: jumps straight to the oldest application still waiting. */
routes.get('/review', async (req, res) => {
  const { rows: [next] } = await query(
    "SELECT id FROM submissions WHERE guild_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1", [config.guildId],
  );
  if (next) return res.redirect(`/submissions/${next.id}`);
  flash(req, 'success', 'No applications are waiting for review. 🎉');
  return res.redirect('/submissions');
});

/* ---------- Settings ---------- */

routes.get('/settings', requireAdmin, async (req, res) => {
  res.render('settings', { title: 'Settings', settings: await getSettings(), opts: guildOptions(res.locals.guild), timezones: allTimezones() });
});

routes.post('/settings', requireAdmin, async (req, res) => {
  const opts = guildOptions(res.locals.guild);
  const b = req.body;
  const patch = {
    staff_role_id: pickId(b.staff_role_id, opts.roles),
    apply_channel_id: pickId(b.apply_channel_id, opts.textChannels),
    submissions_channel_id: pickId(b.submissions_channel_id, opts.textChannels),
    ticket_channel_id: pickId(b.ticket_channel_id, opts.textChannels),
    ticket_category_id: pickId(b.ticket_category_id, opts.categories),
    ticket_log_channel_id: pickId(b.ticket_log_channel_id, opts.textChannels),
    interview_category_id: pickId(b.interview_category_id, opts.categories),
    manager_role_id: pickId(b.manager_role_id, opts.roles),
    strike_log_channel_id: pickId(b.strike_log_channel_id, opts.textChannels),
    loa_role_id: pickId(b.loa_role_id, opts.roles),
    loa_channel_id: pickId(b.loa_channel_id, opts.textChannels),
  };
  if (Object.values(patch).includes(undefined)) {
    flash(req, 'error', 'One of the channels or roles no longer exists. Refresh and try again.');
    return res.redirect('/settings');
  }
  const before = await getSettings();
  if (patch.apply_channel_id !== before.apply_channel_id) patch.apply_panel_message_id = null;
  if (patch.ticket_channel_id !== before.ticket_channel_id) patch.ticket_panel_message_id = null;

  patch.blocked_role_ids = toArray(b.blocked_role_ids).map(String).filter((id) => opts.roles.some((r) => r.id === id));
  const tz = String(b.timezone || '').trim();
  patch.timezone = isValidTimezone(tz) ? tz : before.timezone;
  patch.strike_role_ids = [b.strike_role_1, b.strike_role_2, b.strike_role_3].map((v) => pickId(v, opts.roles)).filter(Boolean);
  const hours = Number.parseInt(b.auto_close_hours, 10);
  patch.auto_close_hours = Number.isFinite(hours) ? Math.min(Math.max(hours, 0), 720) : 48;
  invalidatePanelCache();

  patch.apply_panel_title = clean(b.apply_panel_title, LIMITS.panelTitle) || 'Staff Applications';
  patch.apply_panel_description = clean(b.apply_panel_description, LIMITS.panelDescription) || 'Pick what you are applying for below.';
  patch.ticket_panel_title = clean(b.ticket_panel_title, LIMITS.panelTitle) || 'Need help?';
  patch.ticket_panel_description = clean(b.ticket_panel_description, LIMITS.panelDescription) || 'Click the button below to open a ticket.';
  const cooldown = Number.parseInt(b.apply_cooldown_days, 10);
  patch.apply_cooldown_days = Number.isFinite(cooldown) ? Math.min(Math.max(cooldown, 0), 365) : 7;

  setTicketSettings(await updateSettings(patch));

  // "Save and post panel" buttons: save first, then post or update that panel with the new text
  const post = b.then_post === 'apply' || b.then_post === 'ticket' ? b.then_post : null;
  const tab = ['general', 'applications', 'tickets', 'staff'].includes(b.tab) ? b.tab : '';
  if (post) {
    try {
      const r = await publishPanel(post);
      flash(req, 'success', `Settings saved, and the ${post === 'apply' ? 'application' : 'ticket'} panel was ${r.updated ? 'updated' : 'posted'} in Discord.`);
    } catch (err) {
      flash(req, 'error', `Settings saved, but the panel could not be posted: ${err.message}`);
    }
  } else {
    flash(req, 'success', 'Settings saved.');
  }
  res.redirect(`/settings${tab ? `#${tab}` : ''}`);
});

routes.post('/settings/panel/:kind', requireAdmin, async (req, res) => {
  const kind = req.params.kind === 'ticket' ? 'ticket' : 'apply';
  try {
    const r = await publishPanel(kind);
    flash(req, 'success', `${kind === 'apply' ? 'Application' : 'Ticket'} panel ${r.updated ? 'updated' : 'posted'}.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect('/settings#panels');
});

/* ---------- Applications: categories + roles ---------- */

routes.get('/applications', requireAdmin, async (req, res) => {
  const cats = await listCategories();
  const { timezone: tz } = await getSettings();
  for (const c of cats) {
    c.roles = await listRoles(c.id);
    c.schedule = describeSchedule(c, tz);
    c.openNow = isCategoryOpen(c, tz);
    const wh = weeklyHours(c);
    c.inputs = {
      open_at: toLocalInput(c.open_at, tz), close_at: toLocalInput(c.close_at, tz),
      days: WEEK_ORDER.map((d) => ({ d, name: DAY_NAMES[d], on: Boolean(wh[d]), start: wh[d]?.start.text || '', end: wh[d]?.end.text || '' })),
    };
  }
  res.render('applications', { title: 'Applications', cats, days: DAYS, tz });
});

routes.post('/applications/categories', requireAdmin, async (req, res) => {
  const name = clean(req.body.name, LIMITS.name);
  if (!name) { flash(req, 'error', 'Give the category a name.'); return res.redirect('/applications'); }
  const count = (await listCategories()).length;
  if (count >= 25) { flash(req, 'error', 'Discord dropdowns hold at most 25 categories.'); return res.redirect('/applications'); }
  await query('INSERT INTO app_categories (guild_id, name, description, position) VALUES ($1, $2, $3, $4)',
    [config.guildId, name, clean(req.body.description, LIMITS.description), count]);
  flash(req, 'success', `Added "${name}". Now add roles to it.`);
  await refreshApplyPanelQuietly();
  res.redirect('/applications');
});

routes.post('/applications/categories/:id', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const cat = id && await getCategory(id);
  if (!cat) return res.redirect('/applications');
  const b = req.body;
  const name = clean(b.name, LIMITS.name) || cat.name;
  const position = Number.parseInt(b.position, 10);
  const { timezone: tz } = await getSettings();

  const mode = ['always', 'dates', 'weekly'].includes(b.schedule_mode) ? b.schedule_mode : 'always';
  let openAt = null; let closeAt = null; let days = []; let start = null; let end = null;
  if (mode === 'dates') {
    openAt = parseLocalInput(b.open_at, tz);
    closeAt = parseLocalInput(b.close_at, tz);
    if (!openAt && !closeAt) { flash(req, 'error', 'Pick an open date, a close date, or both.'); return res.redirect('/applications'); }
    if (openAt && closeAt && closeAt <= openAt) { flash(req, 'error', 'The close date must be after the open date.'); return res.redirect('/applications'); }
  }
  const hours = {};
  if (mode === 'weekly') {
    for (let d = 0; d <= 6; d++) {
      if (b[`day_${d}_on`] !== 'on') continue;
      const st = parseTime(b[`day_${d}_start`]);
      const en = parseTime(b[`day_${d}_end`]);
      if (!st || !en || st.text === en.text) {
        flash(req, 'error', `${DAY_NAMES[d]}: pick an open time and a different close time.`);
        return res.redirect('/applications');
      }
      hours[d] = { start: st.text, end: en.text };
    }
    if (!Object.keys(hours).length) { flash(req, 'error', 'For a weekly schedule, turn on at least one day.'); return res.redirect('/applications'); }
    days = Object.keys(hours).map(Number);
  }

  await query(
    `UPDATE app_categories SET name = $2, description = $3, enabled = $4, position = $5,
       schedule_mode = $6, open_at = $7, close_at = $8, weekly_days = $9, weekly_start = $10, weekly_end = $11, weekly_hours = $12, emoji = $13 WHERE id = $1`,
    [id, name, clean(b.description, LIMITS.description), b.enabled === 'on', Number.isFinite(position) ? position : cat.position,
      mode, openAt, closeAt, [...new Set(days)].sort(), start, end, JSON.stringify(hours), formEmoji(b.emoji, cat.emoji)],
  );
  const saved = await getCategory(id);
  flash(req, 'success', `Saved "${name}". ${isCategoryOpen(saved, tz) ? 'It is open now.' : `It is closed now: ${describeSchedule(saved, tz).text}.`}`);
  await refreshApplyPanelQuietly();
  res.redirect('/applications');
});

routes.post('/applications/categories/:id/delete', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const cat = id && await getCategory(id);
  if (cat) {
    await query('DELETE FROM app_categories WHERE id = $1', [id]);
    flash(req, 'success', `Deleted "${cat.name}" and its roles. Past submissions are kept.`);
    await refreshApplyPanelQuietly();
  }
  res.redirect('/applications');
});

routes.post('/applications/categories/:id/roles', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const cat = id && await getCategory(id);
  if (!cat) return res.redirect('/applications');
  const name = clean(req.body.name, LIMITS.name);
  if (!name) { flash(req, 'error', 'Give the role a name.'); return res.redirect('/applications'); }
  const existing = await listRoles(id);
  if (existing.length >= 25) { flash(req, 'error', 'Discord dropdowns hold at most 25 roles per category.'); return res.redirect('/applications'); }
  const { rows } = await query(
    'INSERT INTO app_roles (category_id, name, position, enabled) VALUES ($1, $2, $3, false) RETURNING id',
    [id, name, existing.length],
  );
  flash(req, 'success', `Added "${name}". Write its questions, then switch it on.`);
  res.redirect(`/applications/roles/${rows[0].id}`);
});

routes.get('/applications/roles/:id', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const role = id && await getRole(id);
  if (!role) return res.redirect('/applications');
  res.render('role', {
    title: role.name, role, questions: await listQuestions(id), opts: guildOptions(res.locals.guild),
    settings: await getSettings(), maxQuestions: MAX_QUESTIONS, limits: LIMITS,
  });
});

routes.post('/applications/roles/:id', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const role = id && await getRole(id);
  if (!role) return res.redirect('/applications');
  const opts = guildOptions(res.locals.guild);
  const b = req.body;

  const discordRoleId = pickId(b.discord_role_id, opts.roles);
  const channelId = pickId(b.submissions_channel_id, opts.textChannels);
  if (discordRoleId === undefined || channelId === undefined) {
    flash(req, 'error', 'That Discord role or channel no longer exists. Refresh and try again.');
    return res.redirect(`/applications/roles/${id}`);
  }

  const prompts = toArray(b.questions).map((q) => clean(q, LIMITS.question)).filter(Boolean);
  if (prompts.length > MAX_QUESTIONS) {
    flash(req, 'error', `Keep it to ${MAX_QUESTIONS} questions or fewer.`);
    return res.redirect(`/applications/roles/${id}`);
  }
  let enabled = b.enabled === 'on';
  let note = '';
  if (enabled && !prompts.length) { enabled = false; note = ' It stays switched off until it has at least one question.'; }

  await query(
    `UPDATE app_roles SET name = $2, description = $3, discord_role_id = $4, submissions_channel_id = $5, enabled = $6, emoji = $7 WHERE id = $1`,
    [id, clean(b.name, LIMITS.name) || role.name, clean(b.description, LIMITS.description), discordRoleId, channelId, enabled, formEmoji(b.emoji, role.emoji)],
  );
  await replaceQuestions(id, prompts);
  await refreshApplyPanelQuietly();
  flash(req, enabled || !note ? 'success' : 'error', `Saved "${clean(b.name, LIMITS.name) || role.name}".${note}`);
  res.redirect(`/applications/roles/${id}`);
});

routes.post('/applications/roles/:id/delete', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const role = id && await getRole(id);
  if (role) {
    await query('DELETE FROM app_roles WHERE id = $1', [id]);
    await refreshApplyPanelQuietly();
    flash(req, 'success', `Deleted "${role.name}". Past submissions are kept.`);
  }
  res.redirect('/applications');
});

/* ---------- Submissions ---------- */

const PAGE = 50;

/* ---------- Deleting (admins only) ---------- */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const backTo = (req, fallback) => {
  const r = String(req.body.back || '');
  return r.startsWith('/') && !r.startsWith('//') ? r : fallback;
};

routes.post('/submissions/delete', requireAdmin, async (req, res) => {
  const rows = await deleteSubmissions(toArray(req.body.ids));
  await removeReviewMessages(rows);
  flash(req, rows.length ? 'success' : 'error', rows.length ? `Deleted ${plural(rows.length, 'application')}.` : 'Pick at least one application to delete.');
  res.redirect(backTo(req, '/submissions'));
});

routes.post('/submissions/:id/delete', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const rows = id ? await deleteSubmissions([id]) : [];
  await removeReviewMessages(rows);
  flash(req, rows.length ? 'success' : 'error', rows.length ? `Deleted application #${id}.` : 'That application was already deleted.');
  res.redirect('/submissions');
});

routes.post('/tickets/delete', requireAdmin, async (req, res) => {
  const { deleted, skippedOpen } = await deleteClosedTickets(toArray(req.body.ids));
  const parts = [];
  if (deleted) parts.push(`Deleted ${plural(deleted, 'ticket')}.`);
  if (skippedOpen) parts.push(`${plural(skippedOpen, 'open ticket')} kept: close ${skippedOpen === 1 ? 'it' : 'them'} first.`);
  flash(req, deleted ? 'success' : 'error', parts.join(' ') || 'Pick at least one ticket to delete.');
  res.redirect(backTo(req, '/tickets'));
});

routes.post('/tickets/:id/delete', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const { deleted } = id ? await deleteClosedTickets([id]) : { deleted: 0 };
  flash(req, deleted ? 'success' : 'error', deleted ? 'Ticket and transcript deleted.' : 'Only closed tickets can be deleted. Close it first.');
  res.redirect(deleted ? '/tickets' : `/tickets/${id}`);
});

routes.get('/submissions', async (req, res) => {
  const status = ['pending', 'accepted', 'denied'].includes(req.query.status) ? req.query.status : '';
  const search = clean(req.query.q, 100);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const subs = await listSubmissions({ status, search, limit: PAGE + 1, offset: (page - 1) * PAGE });
  res.render('submissions', { title: 'Submissions', subs: subs.slice(0, PAGE), hasMore: subs.length > PAGE, page, status, search });
});

routes.get('/submissions/:id', async (req, res) => {
  const id = idParam(req);
  const sub = id && await getSubmission(id);
  if (!sub) return res.status(404).render('error', { title: 'Not found', message: 'That application does not exist.', user: res.locals.user });
  const { rows: history } = await query(
    `SELECT id, role_name, status, created_at FROM submissions WHERE guild_id = $1 AND user_id = $2 AND id <> $3 ORDER BY created_at DESC LIMIT 10`,
    [config.guildId, sub.user_id, sub.id],
  );
  const votes = await listVotes(sub.id);
  const myVote = votes.find((v) => v.user_id === res.locals.user.id)?.vote || null;
  // The oldest other application still waiting, for the "Next pending" button
  const { rows: queue } = await query(
    `SELECT id, (SELECT count(*)::int FROM submissions WHERE guild_id = $1 AND status = 'pending' AND id <> $2) AS left
       FROM submissions WHERE guild_id = $1 AND status = 'pending' AND id <> $2 ORDER BY created_at ASC LIMIT 1`,
    [config.guildId, sub.id],
  );
  res.render('submission', {
    title: `Application #${sub.id}`, sub, history, limits: LIMITS, votes, myVote,
    nextPending: queue[0]?.id || null, pendingLeft: queue[0]?.left || 0,
  });
});

routes.post('/submissions/:id/vote', async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/submissions');
  const r = await castVote({ submissionId: id, userId: res.locals.user.id, userTag: res.locals.user.username, vote: req.body.vote });
  flash(req, r.ok ? 'success' : 'error', r.ok ? `${r.vote ? `You voted ${r.vote}.` : 'Your vote was removed.'} Votes: ${r.tally.yes} yes · ${r.tally.no} no.` : r.error);
  res.redirect(`/submissions/${id}`);
});

routes.post('/submissions/:id/interview', async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/submissions');
  const r = await startInterview({ submissionId: id, staffId: res.locals.user.id, staffTag: res.locals.user.username });
  flash(req, r.ok ? 'success' : 'error', r.ok ? `Interview voice channel is ready in Discord. ${r.notes.join(' ')}` : r.error);
  res.redirect(`/submissions/${id}`);
});

routes.post('/submissions/:id/decide', async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/submissions');
  const decision = req.body.decision === 'accepted' ? 'accepted' : 'denied';
  const result = await decideSubmission({
    submissionId: id, decision, reviewerId: res.locals.user.id, reviewerTag: res.locals.user.username,
    reason: clean(req.body.reason, LIMITS.reason) || null,
  });
  flash(req, result.ok ? 'success' : 'error', result.ok ? `${decision === 'accepted' ? 'Accepted' : 'Denied'}. ${result.notes.join(' ')}` : result.error);
  res.redirect(`/submissions/${id}`);
});

/* ---------- Tickets ---------- */

routes.get('/tickets', async (req, res) => {
  const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : '';
  const search = clean(req.query.q, 100);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const tickets = await listTickets({ status, search, limit: PAGE + 1, offset: (page - 1) * PAGE });
  res.render('tickets', { title: 'Tickets', tickets: tickets.slice(0, PAGE), hasMore: tickets.length > PAGE, page, status, search });
});

routes.get('/tickets/:id', async (req, res) => {
  const id = idParam(req);
  const ticket = id && await getTicket(id);
  if (!ticket) return res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist.', user: res.locals.user });
  res.render('ticket', { title: `Ticket #${String(ticket.number).padStart(4, '0')}`, ticket, messages: await listTicketMessages(id) });
});

routes.get('/tickets/:id/transcript.txt', async (req, res) => {
  const id = idParam(req);
  const ticket = id && await getTicket(id);
  if (!ticket) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="ticket-${String(ticket.number).padStart(4, '0')}.txt"`);
  res.send(transcriptText(ticket, await listTicketMessages(id)));
});

routes.post('/tickets/:id/close', async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/tickets');
  const result = await closeTicketFromDashboard(id, res.locals.user.id, res.locals.user.username);
  flash(req, result.ok ? 'success' : 'error', result.ok ? 'Ticket closed. The transcript was saved and the channel will be deleted.' : result.error);
  res.redirect(`/tickets/${id}`);
});
