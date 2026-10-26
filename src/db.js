import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

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
  'apply_cooldown_days',
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
    `INSERT INTO submissions (guild_id, user_id, user_tag, role_id, role_name, category_name, answers)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [config.guildId, s.userId, s.userTag, s.roleId, s.roleName, s.categoryName, JSON.stringify(s.answers)],
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

export async function createTicket({ openerId, openerTag, topic }) {
  const { rows } = await query(
    `INSERT INTO tickets (guild_id, number, opener_id, opener_tag, topic)
     VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE guild_id = $1), $2, $3, $4)
     RETURNING *`,
    [config.guildId, openerId, openerTag, topic],
  );
  return rows[0];
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
       (SELECT count(*)::int FROM tickets WHERE guild_id = $1) AS tickets`,
    [config.guildId],
  );
  return rows[0];
}
