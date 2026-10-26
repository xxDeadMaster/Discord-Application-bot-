import { config } from './config.js';
import { query } from './db.js';

/**
 * Per-person staff activity since a date (or all time when since is null).
 * Returns a Map userId -> { reviews, accepted, denied, votes, interviews, claimed, closed, ratings, ratingSum, strikes, tag }.
 */
export async function staffActivity(since = null) {
  const g = config.guildId;
  const s = since ? new Date(since) : new Date(0);
  const rows = await Promise.all([
    query(`SELECT reviewed_by AS id, max(reviewed_by_tag) AS tag, count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'accepted')::int AS accepted, count(*) FILTER (WHERE status = 'denied')::int AS denied
             FROM submissions WHERE guild_id = $1 AND reviewed_by IS NOT NULL AND reviewed_at >= $2 GROUP BY reviewed_by`, [g, s]),
    query(`SELECT v.user_id AS id, max(v.user_tag) AS tag, count(*)::int AS n
             FROM submission_votes v JOIN submissions x ON x.id = v.submission_id
            WHERE x.guild_id = $1 AND v.created_at >= $2 GROUP BY v.user_id`, [g, s]),
    query(`SELECT interview_by AS id, max(interview_by_tag) AS tag, count(*)::int AS n
             FROM submissions WHERE guild_id = $1 AND interview_by IS NOT NULL AND interview_at >= $2 GROUP BY interview_by`, [g, s]),
    query(`SELECT claimed_by AS id, max(claimed_by_tag) AS tag, count(*)::int AS n
             FROM tickets WHERE guild_id = $1 AND claimed_by IS NOT NULL AND claimed_at >= $2 GROUP BY claimed_by`, [g, s]),
    query(`SELECT closed_by AS id, max(closed_by_tag) AS tag, count(*)::int AS n
             FROM tickets WHERE guild_id = $1 AND closed_by IS NOT NULL AND closed_by <> opener_id AND closed_at >= $2 GROUP BY closed_by`, [g, s]),
    query(`SELECT claimed_by AS id, max(claimed_by_tag) AS tag, count(*)::int AS n, sum(rating)::int AS total
             FROM tickets WHERE guild_id = $1 AND claimed_by IS NOT NULL AND rating IS NOT NULL AND rated_at >= $2 GROUP BY claimed_by`, [g, s]),
    query(`SELECT user_id AS id, max(user_tag) AS tag, count(*)::int AS n
             FROM strikes WHERE guild_id = $1 AND revoked_at IS NULL GROUP BY user_id`, [g]),
  ]);

  const out = new Map();
  const get = (r) => {
    if (!out.has(r.id)) out.set(r.id, { id: r.id, tag: r.tag, reviews: 0, accepted: 0, denied: 0, votes: 0, interviews: 0, claimed: 0, closed: 0, ratings: 0, ratingSum: 0, strikes: 0 });
    const e = out.get(r.id);
    if (!e.tag && r.tag) e.tag = r.tag;
    return e;
  };
  const [reviews, votes, interviews, claimed, closed, ratings, strikes] = rows.map((r) => r.rows);
  for (const r of reviews) Object.assign(get(r), { reviews: r.n, accepted: r.accepted, denied: r.denied });
  for (const r of votes) get(r).votes = r.n;
  for (const r of interviews) get(r).interviews = r.n;
  for (const r of claimed) get(r).claimed = r.n;
  for (const r of closed) get(r).closed = r.n;
  for (const r of ratings) Object.assign(get(r), { ratings: r.n, ratingSum: r.total });
  for (const r of strikes) get(r).strikes = r.n;
  return out;
}

/** Total actions, used to sort the activity table. */
export const activityScore = (e) => e.reviews + e.votes + e.interviews + e.claimed + e.closed;
