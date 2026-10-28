import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
  // Close idle connections quickly so serverless databases (like Neon's free plan) can sleep
  idleTimeoutMillis: 10_000,
});
pool.on('error', (err) => console.warn('[db] idle connection error:', err.message));

export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

/** Returns a stored secret, creating a random one the first time. */
export async function getOrCreateSecret(name) {
  const value = (await import('node:crypto')).randomBytes(48).toString('hex');
  await query('INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, value]);
  const { rows } = await query('SELECT value FROM app_secrets WHERE name = $1', [name]);
  return rows[0].value;
}

/* ---------- Settings ---------- */

export async function getSettings(guildId = config.guildId) {
  await query('INSERT INTO settings (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
  const { rows } = await query('SELECT * FROM settings WHERE guild_id = $1', [guildId]);
  return rows[0];
}

const SETTINGS_FIELDS = [
  'apply_channel_id', 'submissions_channel_id', 'ticket_channel_id', 'ticket_category_id',
  'ticket_log_channel_id', 'staff_role_id', 'apply_panel_message_id', 'ticket_panel_message_id',
  'apply_panel_title', 'apply_panel_description', 'ticket_panel_title', 'ticket_panel_description',
  'apply_cooldown_days', 'blocked_role_ids', 'interview_category_id', 'timezone',
  'auto_close_hours', 'manager_role_id', 'strike_role_ids', 'strike_log_channel_id', 'loa_role_id', 'loa_channel_id',
  'giveaway_ping_role_id', 'mod_log_channel_id', 'trap_channel_id', 'trap_message_id', 'trap_caught',
  'roblox_role_id', 'auto_answer_channel_ids',
  'staff_report_channel_id', 'staff_report_day', 'staff_report_hour', 'staff_report_last',
];

export async function updateSettings(patch, guildId = config.guildId) {
  const keys = Object.keys(patch).filter((k) => SETTINGS_FIELDS.includes(k));
  if (!keys.length) return getSettings(guildId);
  await getSettings(guildId);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await query(
    `UPDATE settings SET ${sets}, updated_at = now() WHERE guild_id = $1 RETURNING *`,
    [guildId, ...keys.map((k) => patch[k])],
  );
  return rows[0];
}

/* ---------- Application categories, roles, questions ---------- */

export async function listCategories({ enabledOnly = false } = {}, guildId = config.guildId) {
  const { rows } = await query(
    `SELECT * FROM app_categories WHERE guild_id = $1 ${enabledOnly ? 'AND enabled' : ''} ORDER BY position, id`,
    [guildId],
  );
  return rows;
}

export async function getCategory(id) {
  const { rows } = await query('SELECT * FROM app_categories WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function listRoles(categoryId, { enabledOnly = false } = {}) {
  const { rows } = await query(
    `SELECT r.*, (SELECT count(*)::int FROM app_questions q WHERE q.role_id = r.id) AS question_count
       FROM app_roles r WHERE r.category_id = $1 ${enabledOnly ? 'AND r.enabled' : ''}
      ORDER BY r.position, r.id`,
    [categoryId],
  );
  return rows;
}

export async function getRole(id) {
  const { rows } = await query(
    `SELECT r.*, c.name AS category_name, c.guild_id
       FROM app_roles r JOIN app_categories c ON c.id = r.category_id
      WHERE r.id = $1 AND c.guild_id = $2`,
    [id, config.guildId],
  );
  return rows[0] || null;
}

export async function listQuestions(roleId) {
  const { rows } = await query('SELECT * FROM app_questions WHERE role_id = $1 ORDER BY position, id', [roleId]);
  return rows;
}

export async function replaceQuestions(roleId, prompts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM app_questions WHERE role_id = $1', [roleId]);
    for (let i = 0; i < prompts.length; i++) {
      await client.query('INSERT INTO app_questions (role_id, prompt, position) VALUES ($1, $2, $3)', [roleId, prompts[i], i]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- Submissions ---------- */

export async function createSubmission(s) {
  const { rows } = await query(
    `INSERT INTO submissions (guild_id, user_id, user_tag, role_id, role_name, category_name, answers, role_emoji, user_avatar)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [config.guildId, s.userId, s.userTag, s.roleId, s.roleName, s.categoryName, JSON.stringify(s.answers), s.roleEmoji || null, s.userAvatar || null],
  );
  return rows[0];
}

export async function getSubmission(id) {
  const { rows } = await query('SELECT * FROM submissions WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function setSubmissionMessage(id, channelId, messageId) {
  await query('UPDATE submissions SET review_channel_id = $2, review_message_id = $3 WHERE id = $1', [id, channelId, messageId]);
}

/** Moves a pending submission to accepted/denied. Returns null if it was already reviewed. */
export async function reviewSubmission(id, status, reviewerId, reviewerTag, reason) {
  const { rows } = await query(
    `UPDATE submissions SET status = $2, reviewed_by = $3, reviewed_by_tag = $4, reason = $5, reviewed_at = now()
      WHERE id = $1 AND guild_id = $6 AND status = 'pending' RETURNING *`,
    [id, status, reviewerId, reviewerTag, reason || null, config.guildId],
  );
  return rows[0] || null;
}

export async function findPendingSubmission(userId) {
  const { rows } = await query(
    `SELECT * FROM submissions WHERE guild_id = $1 AND user_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [config.guildId, userId],
  );
  return rows[0] || null;
}

export async function findLastDenied(userId, roleId) {
  const { rows } = await query(
    `SELECT * FROM submissions WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND status = 'denied'
      ORDER BY reviewed_at DESC LIMIT 1`,
    [config.guildId, userId, roleId],
  );
  return rows[0] || null;
}

export async function listSubmissions({ status, roleId, search, limit = 50, offset = 0 } = {}) {
  const where = ['guild_id = $1'];
  const params = [config.guildId];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (roleId) { params.push(roleId); where.push(`role_id = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`, search);
    where.push(`(user_tag ILIKE $${params.length - 1} OR user_id = $${params.length})`);
  }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM submissions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/* ---------- Tickets ---------- */

export async function createTicket({ openerId, openerTag, topic, typeId = null, typeName = null, typeEmoji = null, answers = [] }) {
  const { rows } = await query(
    `INSERT INTO tickets (guild_id, number, opener_id, opener_tag, topic, type_id, type_name, answers, type_emoji)
     VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE guild_id = $1), $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [config.guildId, openerId, openerTag, topic, typeId, typeName, JSON.stringify(answers), typeEmoji],
  );
  return rows[0];
}

export async function updateTicket(id, fields) {
  const allowed = ['claimed_by', 'claimed_by_tag', 'claimed_at', 'welcome_message_id', 'rating', 'rated_at'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getTicket(id);
  const { rows } = await query(
    `UPDATE tickets SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => fields[k])],
  );
  return rows[0] || null;
}

/* ---------- Ticket types ---------- */

export async function listTicketTypes({ enabledOnly = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM ticket_types WHERE guild_id = $1 ${enabledOnly ? 'AND enabled' : ''} ORDER BY position, id`,
    [config.guildId],
  );
  return rows;
}

export async function getTicketType(id) {
  const { rows } = await query('SELECT * FROM ticket_types WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function setTicketChannel(id, channelId) {
  await query('UPDATE tickets SET channel_id = $2 WHERE id = $1', [id, channelId]);
}

export async function deleteTicket(id) {
  await query('DELETE FROM tickets WHERE id = $1', [id]);
}

export async function getTicket(id) {
  const { rows } = await query('SELECT * FROM tickets WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function getOpenTicketByChannel(channelId) {
  const { rows } = await query(`SELECT * FROM tickets WHERE channel_id = $1 AND status = 'open'`, [channelId]);
  return rows[0] || null;
}

export async function findOpenTicketForUser(userId) {
  const { rows } = await query(
    `SELECT * FROM tickets WHERE guild_id = $1 AND opener_id = $2 AND status = 'open' LIMIT 1`,
    [config.guildId, userId],
  );
  return rows[0] || null;
}

export async function listOpenTicketChannelIds() {
  const { rows } = await query(`SELECT channel_id FROM tickets WHERE guild_id = $1 AND status = 'open' AND channel_id IS NOT NULL`, [config.guildId]);
  return rows.map((r) => r.channel_id);
}

/** Marks a ticket closed. Returns null if it was already closed. */
export async function closeTicket(id, closedById, closedByTag) {
  const { rows } = await query(
    `UPDATE tickets SET status = 'closed', closed_by = $2, closed_by_tag = $3, closed_at = now()
      WHERE id = $1 AND status = 'open' RETURNING *`,
    [id, closedById, closedByTag],
  );
  return rows[0] || null;
}

export async function addTicketMessage(ticketId, m) {
  await query(
    `INSERT INTO ticket_messages (ticket_id, author_id, author_tag, is_bot, content, attachments, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ticketId, m.authorId, m.authorTag, m.isBot, m.content, JSON.stringify(m.attachments || []), m.createdAt || new Date()],
  );
}

export async function listTicketMessages(ticketId) {
  const { rows } = await query('SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at, id', [ticketId]);
  return rows;
}

export async function listTickets({ status, search, limit = 50, offset = 0 } = {}) {
  const where = ['t.guild_id = $1'];
  const params = [config.guildId];
  if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`(t.opener_tag ILIKE $${params.length} OR t.topic ILIKE $${params.length})`); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT t.*, (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM tickets t WHERE ${where.join(' AND ')}
      ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export async function dashboardCounts() {
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM submissions WHERE guild_id = $1 AND status = 'pending') AS pending,
       (SELECT count(*)::int FROM submissions WHERE guild_id = $1) AS submissions,
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1 AND status = 'open') AS open_tickets,
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1) AS tickets,
       (SELECT count(*)::int FROM loa_requests WHERE guild_id = $1 AND status = 'pending') AS pending_loa`,
    [config.guildId],
  );
  return rows[0];
}

/* ---------- Deleting ---------- */

const cleanIds = (ids) => [...new Set(ids.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isSafeInteger(n) && n > 0))];

/** Deletes submissions and returns the deleted rows (so their Discord cards can be removed). */
export async function deleteSubmissions(ids) {
  const list = cleanIds(ids);
  if (!list.length) return [];
  const { rows } = await query(
    'DELETE FROM submissions WHERE guild_id = $1 AND id = ANY($2::int[]) RETURNING id, review_channel_id, review_message_id',
    [config.guildId, list],
  );
  return rows;
}

/** Deletes closed tickets and their transcripts. Open tickets are skipped. Returns { deleted, skippedOpen }. */
export async function deleteClosedTickets(ids) {
  const list = cleanIds(ids);
  if (!list.length) return { deleted: 0, skippedOpen: 0 };
  const { rows } = await query(
    `DELETE FROM tickets WHERE guild_id = $1 AND id = ANY($2::int[]) AND status = 'closed' RETURNING id`,
    [config.guildId, list],
  );
  return { deleted: rows.length, skippedOpen: list.length - rows.length };
}

/* ---------- Votes ---------- */

/** Sets (or clears, when it matches the current vote) a staff member's vote. Returns the new vote or null. */
export async function toggleVote(submissionId, userId, userTag, vote) {
  const { rows } = await query('SELECT vote FROM submission_votes WHERE submission_id = $1 AND user_id = $2', [submissionId, userId]);
  if (rows[0]?.vote === vote) {
    await query('DELETE FROM submission_votes WHERE submission_id = $1 AND user_id = $2', [submissionId, userId]);
    return null;
  }
  await query(
    `INSERT INTO submission_votes (submission_id, user_id, user_tag, vote) VALUES ($1, $2, $3, $4)
     ON CONFLICT (submission_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, user_tag = EXCLUDED.user_tag, created_at = now()`,
    [submissionId, userId, userTag, vote],
  );
  return vote;
}

export async function listVotes(submissionId) {
  const { rows } = await query('SELECT * FROM submission_votes WHERE submission_id = $1 ORDER BY created_at', [submissionId]);
  return rows;
}

export async function voteTally(submissionId) {
  const votes = await listVotes(submissionId);
  return { yes: votes.filter((v) => v.vote === 'yes').length, no: votes.filter((v) => v.vote === 'no').length, votes };
}

/* ---------- Interviews ---------- */

export async function setInterview(submissionId, fields) {
  const keys = Object.keys(fields).filter((k) => ['interview_status', 'interview_channel_id', 'interview_by', 'interview_by_tag', 'interview_at', 'interview_joined'].includes(k));
  if (!keys.length) return null;
  const { rows } = await query(
    `UPDATE submissions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [submissionId, ...keys.map((k) => fields[k])],
  );
  return rows[0] || null;
}

export async function getSubmissionByInterviewChannel(channelId) {
  const { rows } = await query(`SELECT * FROM submissions WHERE interview_channel_id = $1 AND interview_status = 'active'`, [channelId]);
  return rows[0] || null;
}

export async function listActiveInterviews() {
  const { rows } = await query(`SELECT * FROM submissions WHERE guild_id = $1 AND interview_status = 'active'`, [config.guildId]);
  return rows;
}

/* ---------- Strikes ---------- */

export async function addStrike({ userId, userTag, reason, issuedBy, issuedByTag }) {
  const { rows } = await query(
    `INSERT INTO strikes (guild_id, user_id, user_tag, reason, issued_by, issued_by_tag) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [config.guildId, userId, userTag, reason, issuedBy, issuedByTag],
  );
  return rows[0];
}

export async function activeStrikes(userId) {
  const { rows } = await query(
    `SELECT * FROM strikes WHERE guild_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY created_at`,
    [config.guildId, userId],
  );
  return rows;
}

export async function revokeStrike(id, byTag) {
  const { rows } = await query(
    `UPDATE strikes SET revoked_at = now(), revoked_by_tag = $3 WHERE id = $1 AND guild_id = $2 AND revoked_at IS NULL RETURNING *`,
    [id, config.guildId, byTag],
  );
  return rows[0] || null;
}

export async function listStrikes({ userId, includeRevoked = true, limit = 200 } = {}) {
  const where = ['guild_id = $1'];
  const params = [config.guildId];
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (!includeRevoked) where.push('revoked_at IS NULL');
  params.push(limit);
  const { rows } = await query(`SELECT * FROM strikes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

/* ---------- LOA ---------- */

export async function createLoa({ userId, userTag, startDate, endDate, reason }) {
  const { rows } = await query(
    `INSERT INTO loa_requests (guild_id, user_id, user_tag, start_date, end_date, reason) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [config.guildId, userId, userTag, startDate, endDate, reason],
  );
  return rows[0];
}

export async function getLoa(id) {
  const { rows } = await query('SELECT * FROM loa_requests WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function updateLoa(id, fields) {
  const allowed = ['status', 'role_applied', 'reviewed_by', 'reviewed_by_tag', 'reviewed_at', 'message_channel_id', 'message_id', 'ended_at'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getLoa(id);
  const { rows } = await query(
    `UPDATE loa_requests SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => fields[k])],
  );
  return rows[0] || null;
}

/** Pending -> approved/denied, only if still pending. */
export async function decideLoaRow(id, status, byId, byTag) {
  const { rows } = await query(
    `UPDATE loa_requests SET status = $2, reviewed_by = $3, reviewed_by_tag = $4, reviewed_at = now()
      WHERE id = $1 AND guild_id = $5 AND status = 'pending' RETURNING *`,
    [id, status, byId, byTag, config.guildId],
  );
  return rows[0] || null;
}

export async function findOpenLoa(userId) {
  const { rows } = await query(
    `SELECT * FROM loa_requests WHERE guild_id = $1 AND user_id = $2 AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 1`,
    [config.guildId, userId],
  );
  return rows[0] || null;
}

export async function listLoas({ status, limit = 200 } = {}) {
  const params = [config.guildId];
  let where = 'guild_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(limit);
  const { rows } = await query(`SELECT * FROM loa_requests WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

/* ---------- Welcome + verification config ---------- */

const WELCOME_FIELDS = [
  'join_enabled', 'join_channel_id', 'join_message', 'join_card', 'join_dm_enabled', 'join_dm_message', 'auto_role_ids',
  'rules_channel_id', 'leave_enabled', 'leave_channel_id', 'leave_message', 'leave_card',
  'boost_enabled', 'boost_channel_id', 'boost_message', 'boost_card',
  'verify_channel_id', 'verify_role_id', 'verify_title', 'verify_message', 'verify_min_account_days',
  'verify_log_channel_id', 'verify_panel_message_id',
];

export async function getWelcomeConfig(guildId = config.guildId) {
  await query('INSERT INTO welcome_config (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
  const { rows } = await query('SELECT * FROM welcome_config WHERE guild_id = $1', [guildId]);
  return rows[0];
}

export async function updateWelcomeConfig(patch, guildId = config.guildId) {
  const keys = Object.keys(patch).filter((k) => WELCOME_FIELDS.includes(k));
  if (!keys.length) return getWelcomeConfig(guildId);
  await getWelcomeConfig(guildId);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await query(
    `UPDATE welcome_config SET ${sets}, updated_at = now() WHERE guild_id = $1 RETURNING *`,
    [guildId, ...keys.map((k) => patch[k])],
  );
  return rows[0];
}

/* ---------- Giveaways ---------- */

export async function createGiveaway(g) {
  const { rows } = await query(
    `INSERT INTO giveaways (guild_id, channel_id, prize, description, winner_count, required_role_id, ends_at, host_id, host_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [config.guildId, g.channelId, g.prize, g.description || '', g.winnerCount, g.requiredRoleId || null, g.endsAt, g.hostId || null, g.hostTag || null],
  );
  return rows[0];
}

export async function getGiveaway(id) {
  const { rows } = await query(
    `SELECT g.*, (SELECT count(*)::int FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entry_count
       FROM giveaways g WHERE g.id = $1 AND g.guild_id = $2`, [id, config.guildId]);
  return rows[0] || null;
}

export async function listGiveaways({ status = null, limit = 100 } = {}) {
  const params = [config.guildId];
  let where = 'g.guild_id = $1';
  if (status) { params.push(status); where += ` AND g.status = $${params.length}`; }
  params.push(limit);
  const { rows } = await query(
    `SELECT g.*, (SELECT count(*)::int FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entry_count
       FROM giveaways g WHERE ${where} ORDER BY (g.status = 'active') DESC, g.ends_at DESC LIMIT $${params.length}`, params);
  return rows;
}

export async function updateGiveaway(id, fields) {
  const allowed = ['message_id', 'status', 'winner_ids', 'ended_at', 'ends_at'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getGiveaway(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE giveaways SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
  return getGiveaway(id);
}

export async function deleteGiveaway(id) {
  await query('DELETE FROM giveaways WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
}

/** Enter or leave. Returns { entered: boolean, count }. */
export async function toggleGiveawayEntry(giveawayId, userId) {
  const del = await query('DELETE FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2', [giveawayId, userId]);
  if (!del.rowCount) await query('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [giveawayId, userId]);
  const { rows } = await query('SELECT count(*)::int AS n FROM giveaway_entries WHERE giveaway_id = $1', [giveawayId]);
  return { entered: !del.rowCount, count: rows[0].n };
}

export async function giveawayEntrants(giveawayId) {
  const { rows } = await query('SELECT user_id FROM giveaway_entries WHERE giveaway_id = $1', [giveawayId]);
  return rows.map((r) => r.user_id);
}

/* ---------- Polls ---------- */

export async function createPoll(p) {
  const { rows } = await query(
    `INSERT INTO polls (guild_id, channel_id, question, options, multi, ends_at, host_id, host_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [config.guildId, p.channelId, p.question, p.options, Boolean(p.multi), p.endsAt || null, p.hostId || null, p.hostTag || null],
  );
  return rows[0];
}

export async function getPoll(id) {
  const { rows } = await query('SELECT * FROM polls WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function listPolls({ limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT p.*, (SELECT count(DISTINCT v.user_id)::int FROM poll_votes v WHERE v.poll_id = p.id) AS voter_count
       FROM polls p WHERE p.guild_id = $1 ORDER BY (p.status = 'active') DESC, p.created_at DESC LIMIT $2`, [config.guildId, limit]);
  return rows;
}

export async function updatePoll(id, fields) {
  const allowed = ['message_id', 'status', 'ended_at'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getPoll(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE polls SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
  return getPoll(id);
}

export async function deletePoll(id) {
  await query('DELETE FROM polls WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
}

/**
 * Records a vote. Single choice: picking another option moves the vote, picking the same one removes it.
 * Multiple choice: each option toggles. Returns { voted: boolean }.
 */
export async function votePoll(poll, userId, optionIndex) {
  const had = await query('SELECT 1 FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_index = $3', [poll.id, userId, optionIndex]);
  if (had.rowCount) {
    await query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_index = $3', [poll.id, userId, optionIndex]);
    return { voted: false };
  }
  if (!poll.multi) await query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [poll.id, userId]);
  await query('INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [poll.id, userId, optionIndex]);
  return { voted: true };
}

/** Vote counts per option, plus distinct voters. */
export async function pollResults(poll) {
  const { rows } = await query('SELECT option_index, count(*)::int AS n FROM poll_votes WHERE poll_id = $1 GROUP BY option_index', [poll.id]);
  const counts = poll.options.map((_, i) => rows.find((r) => r.option_index === i)?.n || 0);
  const v = await query('SELECT count(DISTINCT user_id)::int AS n FROM poll_votes WHERE poll_id = $1', [poll.id]);
  return { counts, voters: v.rows[0].n };
}

/* ---------- Server stat counters ---------- */

export async function listCounters() {
  const { rows } = await query('SELECT * FROM stat_counters WHERE guild_id = $1 ORDER BY position, id', [config.guildId]);
  return rows;
}

/** Replaces all counters with this list: [{ channelId, kind, template }]. */
export async function replaceCounters(list) {
  await query('DELETE FROM stat_counters WHERE guild_id = $1', [config.guildId]);
  let i = 0;
  for (const c of list) {
    await query(
      'INSERT INTO stat_counters (guild_id, channel_id, kind, template, position) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (guild_id, channel_id) DO NOTHING',
      [config.guildId, c.channelId, c.kind, c.template, i++],
    );
  }
  return listCounters();
}

/* ---------- Role menus ---------- */

export async function listRoleMenus() {
  const { rows } = await query('SELECT * FROM role_menus WHERE guild_id = $1 ORDER BY id', [config.guildId]);
  return rows;
}

export async function getRoleMenu(id) {
  const { rows } = await query('SELECT * FROM role_menus WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function saveRoleMenu({ id = null, channelId, title, description, items }) {
  if (id) {
    const { rows } = await query(
      'UPDATE role_menus SET channel_id = $2, title = $3, description = $4, items = $5 WHERE id = $1 AND guild_id = $6 RETURNING *',
      [id, channelId, title, description, JSON.stringify(items), config.guildId],
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    'INSERT INTO role_menus (guild_id, channel_id, title, description, items) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [config.guildId, channelId, title, description, JSON.stringify(items)],
  );
  return rows[0];
}

export async function setRoleMenuMessage(id, channelId, messageId) {
  await query('UPDATE role_menus SET channel_id = $2, message_id = $3 WHERE id = $1', [id, channelId, messageId]);
}

export async function deleteRoleMenu(id) {
  await query('DELETE FROM role_menus WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
}

/* ---------- Leveling ---------- */

const LEVELING_FIELDS = [
  'enabled', 'announce_channel_id', 'announce_message', 'message_xp', 'message_cooldown', 'voice_xp', 'voice_minutes',
  'daily_xp', 'qotd_channel_id', 'qotd_xp', 'boost_xp', 'no_xp_channel_ids', 'no_xp_role_ids', 'rewards',
];

export async function getLevelingConfig() {
  await query('INSERT INTO leveling_config (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [config.guildId]);
  const { rows } = await query('SELECT * FROM leveling_config WHERE guild_id = $1', [config.guildId]);
  return rows[0];
}

export async function updateLevelingConfig(patch) {
  const keys = Object.keys(patch).filter((k) => LEVELING_FIELDS.includes(k));
  await getLevelingConfig();
  if (!keys.length) return getLevelingConfig();
  const values = keys.map((k) => (k === 'rewards' ? JSON.stringify(patch[k]) : patch[k]));
  const { rows } = await query(
    `UPDATE leveling_config SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE guild_id = $1 RETURNING *`,
    [config.guildId, ...values],
  );
  return rows[0];
}

export async function loadAllLevels() {
  const { rows } = await query('SELECT user_id, user_tag, xp, last_daily, last_qotd FROM member_levels WHERE guild_id = $1', [config.guildId]);
  return rows;
}

/** Saves many members at once in a single query: [{ userId, tag, xp, lastDaily, lastQotd }]. */
export async function saveLevels(list) {
  if (!list.length) return;
  await query(
    `INSERT INTO member_levels (guild_id, user_id, user_tag, xp, last_daily, last_qotd, updated_at)
     SELECT $1, u.user_id, u.user_tag, u.xp, u.last_daily, u.last_qotd, now()
       FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[]) AS u(user_id, user_tag, xp, last_daily, last_qotd)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET user_tag = EXCLUDED.user_tag, xp = EXCLUDED.xp,
       last_daily = EXCLUDED.last_daily, last_qotd = EXCLUDED.last_qotd, updated_at = now()`,
    [config.guildId, list.map((l) => l.userId), list.map((l) => l.tag || ''), list.map((l) => l.xp),
      list.map((l) => l.lastDaily || null), list.map((l) => l.lastQotd || null)],
  );
}

/* ---------- Moderation cases ---------- */

export async function addModCase(c) {
  const { rows } = await query(
    `INSERT INTO mod_cases (guild_id, user_id, user_tag, mod_id, mod_tag, action, reason, duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [config.guildId, c.userId, c.userTag || '', c.modId || null, c.modTag || '', c.action, c.reason || '', c.durationMinutes ?? null],
  );
  return rows[0];
}

export async function listModCases({ userId = null, action = null, search = null, limit = 50, offset = 0 } = {}) {
  const params = [config.guildId];
  const where = ['guild_id = $1'];
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (action) { params.push(action); where.push(`action = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`(user_tag ILIKE $${params.length} OR mod_tag ILIKE $${params.length} OR reason ILIKE $${params.length} OR user_id = $${params.length + 1})`); params.push(search); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM mod_cases WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params,
  );
  return rows;
}

export async function getModCase(id) {
  const { rows } = await query('SELECT * FROM mod_cases WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
  return rows[0] || null;
}

export async function deleteModCase(id) {
  await query('DELETE FROM mod_cases WHERE id = $1 AND guild_id = $2', [id, config.guildId]);
}

/** Counts per action since a date: { warn: 3, timeout: 1, ... , total } */
export async function modCounts(since) {
  const { rows } = await query(
    'SELECT action, count(*)::int AS n FROM mod_cases WHERE guild_id = $1 AND created_at >= $2 GROUP BY action', [config.guildId, since],
  );
  const out = { total: 0 };
  for (const r of rows) { out[r.action] = r.n; out.total += r.n; }
  return out;
}

/* ---------- Server snapshots (one row per day) ---------- */

/** Saves a day's totals. joins/leaves are ADDED to what's already saved for that day. */
export async function saveSnapshot(day, s) {
  await query(
    `INSERT INTO server_snapshots (guild_id, day, members, humans, bots, channels, roles, boosts, joins, leaves) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (guild_id, day) DO UPDATE SET members = EXCLUDED.members, humans = EXCLUDED.humans, bots = EXCLUDED.bots, channels = EXCLUDED.channels,
       roles = EXCLUDED.roles, boosts = EXCLUDED.boosts,
       joins = server_snapshots.joins + EXCLUDED.joins, leaves = server_snapshots.leaves + EXCLUDED.leaves`,
    [config.guildId, day, s.members, s.humans ?? null, s.bots, s.channels, s.roles, s.boosts, s.joins || 0, s.leaves || 0],
  );
}

export async function listSnapshots(days = 30) {
  const { rows } = await query('SELECT * FROM server_snapshots WHERE guild_id = $1 ORDER BY day DESC LIMIT $2', [config.guildId, days]);
  return rows.reverse();
}
