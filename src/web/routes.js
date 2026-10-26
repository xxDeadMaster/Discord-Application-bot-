import { ChannelType } from 'discord.js';
import express from 'express';
import { decideSubmission, removeReviewMessages } from '../bot/applications.js';
import { publishPanel, refreshApplyPanelQuietly } from '../bot/panels.js';
import { closeTicketFromDashboard, transcriptText } from '../bot/tickets.js';
import { MAX_QUESTIONS, inviteUrl } from '../bot/ui.js';
import { config } from '../config.js';
import {
  dashboardCounts, deleteClosedTickets, deleteSubmissions, getCategory, getRole, getSettings, getSubmission, getTicket, listCategories, listQuestions,
  listRoles, listSubmissions, listTicketMessages, listTickets, query, replaceQuestions, updateSettings,
} from '../db.js';
import { requireAdmin } from './auth.js';

export const routes = express.Router();

const LIMITS = { name: 80, description: 100, question: 500, panelTitle: 200, panelDescription: 2000, reason: 500 };

const flash = (req, type, text) => { req.session.flash = { type, text }; };
const idParam = (req) => {
  const n = Number.parseInt(req.params.id, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function guildOptions(guild) {
  const textChannels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: `#${c.name}`, parent: c.parent?.name || '' }));
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
  const [counts, settings, recentSubs, recentTickets, cats] = await Promise.all([
    dashboardCounts(), getSettings(), listSubmissions({ limit: 5 }), listTickets({ limit: 5 }), listCategories(),
  ]);
  const opts = guildOptions(res.locals.guild);
  const checklist = [
    { done: Boolean(settings.staff_role_id), text: 'Pick a staff role', href: '/settings' },
    { done: Boolean(settings.apply_channel_id && settings.submissions_channel_id), text: 'Pick application + submissions channels', href: '/settings' },
    { done: cats.length > 0, text: 'Add an application category, roles and questions', href: '/applications' },
    { done: Boolean(settings.apply_panel_message_id), text: 'Post the application panel', href: '/settings#panels' },
    { done: Boolean(settings.ticket_channel_id && settings.ticket_panel_message_id), text: 'Pick a ticket channel and post the ticket panel', href: '/settings#panels' },
  ];
  res.render('overview', {
    title: 'Overview', counts, recentSubs, recentTickets, checklist, inviteUrl: inviteUrl(),
    applyChannel: nameOf(opts.textChannels, settings.apply_channel_id),
  });
});

/* ---------- Settings ---------- */

routes.get('/settings', requireAdmin, async (req, res) => {
  res.render('settings', { title: 'Settings', settings: await getSettings(), opts: guildOptions(res.locals.guild) });
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
  };
  if (Object.values(patch).includes(undefined)) {
    flash(req, 'error', 'One of the channels or roles no longer exists. Refresh and try again.');
    return res.redirect('/settings');
  }
  const before = await getSettings();
  if (patch.apply_channel_id !== before.apply_channel_id) patch.apply_panel_message_id = null;
  if (patch.ticket_channel_id !== before.ticket_channel_id) patch.ticket_panel_message_id = null;

  patch.apply_panel_title = clean(b.apply_panel_title, LIMITS.panelTitle) || 'Staff Applications';
  patch.apply_panel_description = clean(b.apply_panel_description, LIMITS.panelDescription) || 'Pick what you are applying for below.';
  patch.ticket_panel_title = clean(b.ticket_panel_title, LIMITS.panelTitle) || 'Need help?';
  patch.ticket_panel_description = clean(b.ticket_panel_description, LIMITS.panelDescription) || 'Click the button below to open a ticket.';
  const cooldown = Number.parseInt(b.apply_cooldown_days, 10);
  patch.apply_cooldown_days = Number.isFinite(cooldown) ? Math.min(Math.max(cooldown, 0), 365) : 7;

  await updateSettings(patch);
  flash(req, 'success', 'Settings saved. If you changed panel text, press "Post or update" below to refresh the panels.');
  res.redirect('/settings');
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
  for (const c of cats) c.roles = await listRoles(c.id);
  res.render('applications', { title: 'Applications', cats });
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
  const name = clean(req.body.name, LIMITS.name) || cat.name;
  const position = Number.parseInt(req.body.position, 10);
  await query('UPDATE app_categories SET name = $2, description = $3, enabled = $4, position = $5 WHERE id = $1',
    [id, name, clean(req.body.description, LIMITS.description), req.body.enabled === 'on', Number.isFinite(position) ? position : cat.position]);
  flash(req, 'success', `Saved "${name}".`);
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
    `UPDATE app_roles SET name = $2, description = $3, discord_role_id = $4, submissions_channel_id = $5, enabled = $6 WHERE id = $1`,
    [id, clean(b.name, LIMITS.name) || role.name, clean(b.description, LIMITS.description), discordRoleId, channelId, enabled],
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
  res.render('submission', { title: `Application #${sub.id}`, sub, history, limits: LIMITS });
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
