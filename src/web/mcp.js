// Claude connector: a remote MCP server at /mcp so Claude can read and act on applications and tickets.
// Add it in Claude under Customize -> Connectors -> Add custom connector, with the connector key
// (from Settings -> General) sent as an "Authorization: Bearer <key>" request header.
// Stateless: every request gets its own server instance, so nothing is kept in memory between calls.
import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { castVote, decideSubmission } from '../bot/applications.js';
import { client } from '../bot/client.js';
import { isOnLoa, prettyDate, todayIn } from '../bot/staff.js';
import { closeTicketFromDashboard } from '../bot/tickets.js';
import { COLORS, accountAge, footer, truncate } from '../bot/ui.js';
import { config } from '../config.js';
import {
  dashboardCounts, getSettings, getSubmission, getTicket, listLoas, listSubmissions, listTicketMessages, listTickets, listVotes, query,
} from '../db.js';
import { activityScore, staffActivity } from '../stats.js';

const ACTOR_ID = 'claude-connector';
const ACTOR_TAG = 'Claude (connector)';

/* ---------- Connector key ---------- */

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');
let keyHashCache; // undefined = not loaded yet, null = no key set

async function currentKeyHash() {
  if (keyHashCache !== undefined) return keyHashCache;
  const { rows } = await query(`SELECT value FROM app_secrets WHERE name = 'mcp_key_hash'`);
  keyHashCache = rows[0]?.value || null;
  return keyHashCache;
}

/** Makes a new key (returns it once; only its hash is stored). */
export async function createConnectorKey() {
  const key = `orbit_${crypto.randomBytes(24).toString('base64url')}`;
  await query(
    `INSERT INTO app_secrets (name, value) VALUES ('mcp_key_hash', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
    [hash(key)],
  );
  keyHashCache = hash(key);
  return key;
}

export async function removeConnectorKey() {
  await query(`DELETE FROM app_secrets WHERE name = 'mcp_key_hash'`);
  keyHashCache = null;
}

export async function connectorEnabled() {
  return Boolean(await currentKeyHash());
}

// Slow down key guessing: max 20 failed attempts per IP per 15 minutes
const failures = new Map();
function tooManyFailures(ip) {
  const e = failures.get(ip);
  if (!e || e.reset < Date.now()) return false;
  return e.n >= 20;
}
function noteFailure(ip) {
  const e = failures.get(ip);
  if (!e || e.reset < Date.now()) failures.set(ip, { n: 1, reset: Date.now() + 15 * 60 * 1000 });
  else e.n += 1;
}

async function checkKey(req, res, next) {
  const ip = req.ip || 'unknown';
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many wrong keys. Try again in 15 minutes.' });
  const stored = await currentKeyHash();
  if (!stored) return res.status(403).json({ error: 'The Claude connector is turned off. Make a key in Orbit Settings -> General.' });
  const header = String(req.get('authorization') || '');
  const sent = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : String(req.get('x-orbit-key') || '').trim();
  const a = Buffer.from(hash(sent || 'none'));
  const b = Buffer.from(stored);
  if (!sent || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    noteFailure(ip);
    return res.status(401).json({ error: 'Missing or wrong connector key.' });
  }
  next();
}

/* ---------- Helpers ---------- */

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const iso = (d) => (d ? new Date(d).toISOString() : null);
const dashboard = (p) => `${config.publicUrl.replace(/\/$/, '')}${p}`;

async function applicationSummary(s) {
  const votes = await listVotes(s.id);
  return {
    id: s.id,
    applicant: s.user_tag,
    applicant_id: s.user_id,
    role: s.role_name,
    category: s.category_name,
    status: s.status,
    submitted: iso(s.created_at),
    votes: { yes: votes.filter((v) => v.vote === 'yes').length, no: votes.filter((v) => v.vote === 'no').length },
    interview: s.interview_status || 'none',
    dashboard: dashboard(`/submissions/${s.id}`),
  };
}

/* ---------- The MCP server ---------- */

const INSTRUCTIONS = `You are connected to Orbit, the staff bot for the BloxVerse Community Discord server (a Roblox community).
Use it to help staff review staff applications and handle support tickets.
- Start with server_overview to see what is waiting.
- Applications: list_applications, then get_application to read answers. Give a clear pass/fail recommendation with reasons
  (effort and detail of answers, maturity, relevant experience, account age, past applications). vote_on_application casts a vote as "Claude".
  decide_application accepts or denies for real (gives the role and DMs the applicant), so only use it when the person you're helping asks for that decision.
- Tickets: list_tickets, then get_ticket to read the conversation. reply_to_ticket posts in the ticket channel as Orbit, so show the person your draft first
  unless they asked you to send it. close_ticket closes and deletes the channel (a transcript is saved).
- Everything you do is logged as "${ACTOR_TAG}".`;

export function buildMcpServer() {
  const server = new McpServer({ name: 'orbit-bloxverse', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('server_overview', {
    title: 'What is waiting',
    description: 'Counts of pending applications and open tickets, the oldest waiting ones, and who is on leave. Start here.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const counts = await dashboardCounts();
    const pending = await listSubmissions({ status: 'pending', limit: 5 });
    const open = await listTickets({ status: 'open', limit: 5 });
    const settings = await getSettings();
    const today = todayIn(settings.timezone);
    const loas = (await listLoas({ status: 'approved' })).filter((l) => l.start_date <= today);
    return text({
      pending_applications: counts.pending,
      open_tickets: counts.open_tickets,
      oldest_pending_applications: await Promise.all(pending.reverse().map(applicationSummary)),
      newest_open_tickets: open.map((t) => ({ id: t.id, number: t.number, type: t.type_name, opener: t.opener_tag, topic: t.topic, claimed_by: t.claimed_by_tag || null, opened: iso(t.created_at) })),
      staff_on_leave: loas.map((l) => ({ member: l.user_tag, until: prettyDate(l.end_date) })),
    });
  });

  /* Applications */

  server.registerTool('list_applications', {
    title: 'List applications',
    description: 'Staff applications, newest first. Defaults to the ones still waiting for a decision.',
    inputSchema: {
      status: z.enum(['pending', 'accepted', 'denied', 'all']).default('pending').describe('Which applications to list'),
      search: z.string().max(100).optional().describe('Filter by applicant name or role'),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: readOnly,
  }, async ({ status, search, limit }) => {
    const rows = await listSubmissions({ status: status === 'all' ? undefined : status, search: search || undefined, limit });
    if (!rows.length) return text(`No ${status === 'all' ? '' : `${status} `}applications found.`);
    return text(await Promise.all(rows.map(applicationSummary)));
  });

  server.registerTool('get_application', {
    title: 'Read an application',
    description: 'Full application: every question and answer, staff votes, interview status, the applicant\'s Discord account age and their earlier applications.',
    inputSchema: { id: z.number().int().positive().describe('Application number, e.g. 12') },
    annotations: readOnly,
  }, async ({ id }) => {
    const s = await getSubmission(id);
    if (!s) return fail(`Application #${id} does not exist.`);
    const votes = await listVotes(s.id);
    const { rows: history } = await query(
      `SELECT id, role_name, status, created_at, reason FROM submissions WHERE guild_id = $1 AND user_id = $2 AND id <> $3 ORDER BY created_at DESC LIMIT 10`,
      [config.guildId, s.user_id, s.id],
    );
    return text({
      ...(await applicationSummary(s)),
      account_age: accountAge(s.user_id),
      answers: s.answers.map((a, i) => ({ n: i + 1, question: a.q, answer: a.a })),
      staff_votes: votes.map((v) => ({ by: v.user_tag, vote: v.vote })),
      decision: s.status === 'pending' ? null : { by: s.reviewed_by_tag, at: iso(s.reviewed_at), note: s.reason || null },
      earlier_applications: history.map((h) => ({ id: h.id, role: h.role_name, status: h.status, date: iso(h.created_at), note: h.reason || null })),
    });
  });

  server.registerTool('vote_on_application', {
    title: 'Vote on an application',
    description: 'Casts a yes or no staff vote as "Claude". Shows on the Discord card and the dashboard. Does not accept or deny.',
    inputSchema: { id: z.number().int().positive(), vote: z.enum(['yes', 'no']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, vote }) => {
    const existing = (await listVotes(id)).find((v) => v.user_id === ACTOR_ID);
    if (existing?.vote === vote) return text(`Claude already voted ${vote} on application #${id}.`);
    const r = await castVote({ submissionId: id, userId: ACTOR_ID, userTag: ACTOR_TAG, vote });
    if (!r.ok) return fail(r.error);
    return text(`Voted ${vote} on application #${id}. Votes now: ${r.tally.yes} yes, ${r.tally.no} no.`);
  });

  server.registerTool('decide_application', {
    title: 'Accept or deny an application',
    description: 'Accepts or denies for real: gives the Discord role on accept, DMs the applicant the result (with the note, if any) and updates the Discord card. Only use when asked to make the decision.',
    inputSchema: {
      id: z.number().int().positive(),
      decision: z.enum(['accept', 'deny']),
      note: z.string().max(500).optional().describe('Optional note sent to the applicant in their DM'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ id, decision, note }) => {
    const r = await decideSubmission({
      submissionId: id, decision: decision === 'accept' ? 'accepted' : 'denied', reviewerId: null, reviewerTag: ACTOR_TAG, reason: note?.trim() || null,
    });
    if (!r.ok) return fail(r.error);
    return text(`Application #${id} ${decision === 'accept' ? 'accepted' : 'denied'}. ${(r.notes || []).join(' ')}`.trim());
  });

  /* Tickets */

  server.registerTool('list_tickets', {
    title: 'List tickets',
    description: 'Support tickets, newest first. Defaults to open ones.',
    inputSchema: {
      status: z.enum(['open', 'closed', 'all']).default('open'),
      search: z.string().max(100).optional().describe('Filter by opener name or topic'),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: readOnly,
  }, async ({ status, search, limit }) => {
    const rows = await listTickets({ status: status === 'all' ? undefined : status, search: search || undefined, limit });
    if (!rows.length) return text(`No ${status === 'all' ? '' : `${status} `}tickets found.`);
    return text(rows.map((t) => ({
      id: t.id, number: t.number, status: t.status, type: t.type_name, opener: t.opener_tag, topic: t.topic,
      claimed_by: t.claimed_by_tag || null, opened: iso(t.created_at), closed: iso(t.closed_at), rating: t.rating || null,
      dashboard: dashboard(`/tickets/${t.id}`),
    })));
  });

  server.registerTool('get_ticket', {
    title: 'Read a ticket',
    description: 'A ticket with the opener\'s answers and the conversation (most recent messages).',
    inputSchema: {
      id: z.number().int().positive().describe('Ticket id from list_tickets (not the #0001 number)'),
      last_messages: z.number().int().min(1).max(200).default(60),
    },
    annotations: readOnly,
  }, async ({ id, last_messages }) => {
    const t = await getTicket(id);
    if (!t) return fail(`Ticket ${id} does not exist.`);
    const msgs = await listTicketMessages(t.id);
    return text({
      id: t.id, number: t.number, status: t.status, type: t.type_name, opener: t.opener_tag, opener_account_age: accountAge(t.opener_id),
      opened: iso(t.created_at), claimed_by: t.claimed_by_tag || null, closed: iso(t.closed_at),
      form_answers: (Array.isArray(t.answers) ? t.answers : []).map((a) => ({ question: a.q, answer: a.a })),
      messages_total: msgs.length,
      messages: msgs.slice(-last_messages).map((m) => ({ at: iso(m.created_at), from: m.author_tag, bot: m.is_bot, text: truncate(m.content || '', 1500), attachments: (m.attachments || []).map((a) => a.name) })),
    });
  });

  server.registerTool('reply_to_ticket', {
    title: 'Reply in a ticket',
    description: 'Posts a message in the ticket channel as Orbit (a "Staff reply" box), visible to the member. Show the draft to the person first unless they asked you to send it.',
    inputSchema: {
      id: z.number().int().positive(),
      message: z.string().min(1).max(1800),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id, message }) => {
    const t = await getTicket(id);
    if (!t) return fail(`Ticket ${id} does not exist.`);
    if (t.status !== 'open' || !t.channel_id) return fail(`Ticket ${id} is closed.`);
    const channel = await client.channels.fetch(t.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return fail('The ticket channel could not be found in Discord.');
    await channel.send({
      embeds: [{ color: COLORS.sky, author: { name: '💬 Staff reply' }, description: message, footer: footer('Sent with Claude', client) }],
      allowedMentions: { parse: [] },
    });
    return text(`Posted in ticket #${String(t.number).padStart(4, '0')}.`);
  });

  server.registerTool('close_ticket', {
    title: 'Close a ticket',
    description: 'Closes a ticket: saves the transcript to the log channel, DMs the opener a copy with a rating request, and deletes the ticket channel.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ id }) => {
    const t = await getTicket(id);
    if (!t) return fail(`Ticket ${id} does not exist.`);
    const r = await closeTicketFromDashboard(id, null, ACTOR_TAG);
    if (!r.ok) return fail(r.error);
    return text(`Ticket #${String(t.number).padStart(4, '0')} closed. The transcript was saved.`);
  });

  /* Staff */

  server.registerTool('staff_activity', {
    title: 'Staff activity',
    description: 'How much each staff member has done: application reviews, votes, interviews, tickets claimed and closed, average rating, active strikes, LOA.',
    inputSchema: { days: z.enum(['7', '30', 'all']).default('30') },
    annotations: readOnly,
  }, async ({ days }) => {
    const since = days === 'all' ? null : new Date(Date.now() - Number(days) * 86400000);
    const rows = [...(await staffActivity(since)).values()]
      .filter((e) => e.id !== ACTOR_ID)
      .sort((a, b) => activityScore(b) - activityScore(a))
      .map((e) => {
        const loa = isOnLoa(e.id);
        return {
          member: e.tag || e.id, reviews: e.reviews, accepted: e.accepted, denied: e.denied, votes: e.votes, interviews: e.interviews,
          tickets_claimed: e.claimed, tickets_closed: e.closed, average_rating: e.ratings ? +(e.ratingSum / e.ratings).toFixed(1) : null,
          active_strikes: e.strikes, on_loa: loa ? `until ${prettyDate(loa.end_date)}` : null,
        };
      });
    return text(rows.length ? rows : 'No staff activity in that period.');
  });

  server.registerTool('list_loa', {
    title: 'Leave of absence',
    description: 'Staff on leave now and upcoming leave.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const settings = await getSettings();
    const today = todayIn(settings.timezone);
    const rows = await listLoas({ status: 'approved' });
    return text(rows.length ? rows.map((l) => ({
      member: l.user_tag, from: prettyDate(l.start_date), until: prettyDate(l.end_date), reason: l.reason || null,
      state: l.start_date <= today ? 'on leave now' : 'upcoming',
    })) : 'Nobody is on leave or has leave coming up.');
  });

  return server;
}

/* ---------- Express route ---------- */

export function mcpRouter() {
  const router = express.Router();
  router.post('/mcp', express.json({ limit: '1mb' }), checkKey, async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp]', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Stateless server: no streams to open or sessions to end
  router.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST.' }));
  return router;
}
