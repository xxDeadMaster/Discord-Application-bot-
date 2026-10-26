import crypto from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import express from 'express';
import { getGuild } from '../bot/client.js';
import { inviteUrl, isStaff } from '../bot/ui.js';
import { config } from '../config.js';
import { getSettings } from '../db.js';

export const authRouter = express.Router();

const redirectUri = () => `${config.publicUrl}/auth/callback`;

authRouter.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', user: null, inviteUrl: inviteUrl() });
});

authRouter.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');
  req.session.save(() => res.redirect(url.toString()));
});

authRouter.get('/auth/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    const expected = req.session.oauthState;
    delete req.session.oauthState;
    if (!code || !state || state !== expected) {
      return res.status(400).render('error', { title: 'Sign-in failed', message: 'The sign-in link expired. Try signing in again.', user: null });
    }

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri(),
      }),
    });
    if (!tokenRes.ok) {
      console.warn('[auth] token exchange failed:', tokenRes.status, await tokenRes.text());
      return res.status(400).render('error', { title: 'Sign-in failed', message: 'Discord did not accept the sign-in. Check the Redirect URL in the Developer Portal matches this site.', user: null });
    }
    const token = await tokenRes.json();

    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!meRes.ok) throw new Error(`users/@me failed: ${meRes.status}`);
    const me = await meRes.json();

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: me.id,
        name: me.global_name || me.username,
        username: me.username,
        avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
      };
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/** Signed in + still staff in the server. Sets res.locals.user, member, isAdmin. */
export async function requireLogin(req, res, next) {
  try {
    if (!req.session.user) return res.redirect('/login');
    const guild = await getGuild().catch(() => null);
    if (!guild) {
      return res.status(503).render('error', { title: 'Bot not in server', message: 'The bot is not in your server yet, or is still starting up. Invite it, then refresh.', user: req.session.user });
    }
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    const settings = await getSettings();
    if (!isStaff(member, settings)) {
      return res.status(403).render('error', {
        title: 'Staff only',
        message: settings.staff_role_id
          ? 'You need the staff role in the server to use this dashboard.'
          : 'No staff role is set yet, so only server admins (Manage Server permission) can sign in.',
        user: req.session.user,
      });
    }
    res.locals.user = req.session.user;
    res.locals.member = member;
    res.locals.guild = guild;
    res.locals.isAdmin = member.permissions.has(PermissionFlagsBits.ManageGuild);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (res.locals.isAdmin) return next();
  res.status(403).render('error', { title: 'Admins only', message: 'Only people with the Manage Server permission can change bot settings.', user: res.locals.user });
}
