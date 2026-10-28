// Dashboard pages: Roblox links, Auto-answers, and the weekly staff report settings.
import express from 'express';
import { getSettings, updateSettings } from '../db.js';
import {
  MAX_ANSWERS, deleteAutoAnswer, listAutoAnswers, loadAutoAnswers, parsePhrases, saveAutoAnswer,
} from '../bot/autoAnswers.js';
import {
  countLinks, getLink, listLinks, profileUrl, removeLink, syncLinkedRole,
} from '../bot/roblox.js';
import { postReport } from '../bot/staffReport.js';
import { requireAdmin } from './auth.js';

export const extrasRoutes = express.Router();

const flash = (req, type, text) => { req.session.flash = { type, text }; };
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const pick = (v, list) => { const x = String(v ?? '').trim(); return x && list.some((i) => i.id === x) ? x : null; };
const idParam = (req) => { const n = Number.parseInt(req.params.id, 10); return Number.isSafeInteger(n) && n > 0 ? n : null; };

function requireManager(req, res, next) {
  if (res.locals.isManager) return next();
  res.status(403).render('error', { title: 'Managers only', message: 'Only managers (Manage Server, or the manager role in Settings) can do this.', user: res.locals.user });
}

/* ---------- Roblox links ---------- */

extrasRoutes.get('/roblox', async (req, res) => {
  const search = clean(req.query.q, 60) || null;
  const [links, total, settings] = await Promise.all([listLinks({ search }), countLinks(), getSettings()]);
  res.render('roblox', { title: 'Roblox links', links, total, search, roleId: settings.roblox_role_id, opts: res.locals.guildOpts(), profileUrl });
});

extrasRoutes.post('/roblox/settings', requireAdmin, async (req, res) => {
  const opts = res.locals.guildOpts();
  await updateSettings({ roblox_role_id: pick(req.body.roblox_role_id, opts.roles) });
  flash(req, 'success', 'Saved. New links get this role (existing ones get it when they re-link or re-join).');
  res.redirect('/roblox');
});

extrasRoutes.post('/roblox/:userId/unlink', requireManager, async (req, res) => {
  const userId = clean(req.params.userId, 25);
  const link = await getLink(userId);
  if (link) {
    await removeLink(userId);
    const member = await res.locals.guild.members.fetch(userId).catch(() => null);
    await syncLinkedRole(member, false);
    flash(req, 'success', `Unlinked @${link.roblox_name} from ${link.user_tag || userId}.`);
  }
  res.redirect('/roblox');
});

/* ---------- Auto-answers ---------- */

extrasRoutes.get('/auto-answers', requireAdmin, async (req, res) => {
  const [answers, settings] = await Promise.all([listAutoAnswers(), getSettings()]);
  res.render('auto-answers', { title: 'Auto-answers', answers, channelIds: settings.auto_answer_channel_ids || [], opts: res.locals.guildOpts(), maxAnswers: MAX_ANSWERS });
});

function answerFromForm(b) {
  const phrases = parsePhrases(b.triggers);
  return { triggers: phrases.join('\n'), answer: clean(b.answer, 1800), enabled: b.enabled === 'on' || b.enabled === '1' };
}

extrasRoutes.post('/auto-answers', requireAdmin, async (req, res) => {
  const a = answerFromForm(req.body);
  if (!a.triggers || !a.answer) { flash(req, 'error', 'Add at least one question phrase and an answer.'); return res.redirect('/auto-answers'); }
  if ((await listAutoAnswers()).length >= MAX_ANSWERS) { flash(req, 'error', `You can have up to ${MAX_ANSWERS} answers.`); return res.redirect('/auto-answers'); }
  const row = await saveAutoAnswer(a);
  await loadAutoAnswers();
  flash(req, 'success', 'Answer added.');
  res.redirect(`/auto-answers#answer-${row.id}`);
});

extrasRoutes.post('/auto-answers/channels', requireAdmin, async (req, res) => {
  const opts = res.locals.guildOpts();
  const ids = toArray(req.body.channel_ids).filter((id) => opts.textChannels.some((c) => c.id === id));
  await updateSettings({ auto_answer_channel_ids: [...new Set(ids)] });
  await loadAutoAnswers();
  flash(req, 'success', `Auto-answers are on in ${ids.length} channel${ids.length === 1 ? '' : 's'}.`);
  res.redirect('/auto-answers');
});

extrasRoutes.post('/auto-answers/:id', requireAdmin, async (req, res) => {
  const id = idParam(req);
  const a = answerFromForm(req.body);
  if (!id || !a.triggers || !a.answer) { flash(req, 'error', 'Add at least one question phrase and an answer.'); return res.redirect('/auto-answers'); }
  await saveAutoAnswer({ id, ...a });
  await loadAutoAnswers();
  flash(req, 'success', 'Answer saved.');
  res.redirect(`/auto-answers#answer-${id}`);
});

extrasRoutes.post('/auto-answers/:id/delete', requireAdmin, async (req, res) => {
  const id = idParam(req);
  if (id) { await deleteAutoAnswer(id); await loadAutoAnswers(); flash(req, 'success', 'Answer deleted.'); }
  res.redirect('/auto-answers');
});

/* ---------- Weekly staff report ---------- */

extrasRoutes.post('/staff/report', requireManager, async (req, res) => {
  const opts = res.locals.guildOpts();
  const day = Number.parseInt(req.body.staff_report_day, 10);
  const hour = Number.parseInt(req.body.staff_report_hour, 10);
  await updateSettings({
    staff_report_channel_id: pick(req.body.staff_report_channel_id, opts.textChannels),
    staff_report_day: day >= 0 && day <= 6 ? day : 0,
    staff_report_hour: hour >= 0 && hour <= 23 ? hour : 18,
  });
  flash(req, 'success', 'Weekly report settings saved.');
  res.redirect('/staff#report');
});

extrasRoutes.post('/staff/report/send', requireManager, async (req, res) => {
  const r = await postReport();
  flash(req, r.ok ? 'success' : 'error', r.ok ? 'Report posted.' : r.error);
  res.redirect('/staff#report');
});
