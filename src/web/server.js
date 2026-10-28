import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import connectPg from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import { config } from '../config.js';
import { pool } from '../db.js';
import { authRouter, requireLogin } from './auth.js';
import { guildOptions, routes } from './routes.js';
import { staffRoutes } from './staffRoutes.js';
import { communityRoutes } from './communityRoutes.js';
import { extrasRoutes } from './extrasRoutes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function startWeb() {
  const app = express();
  const PgStore = connectPg(session);

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  app.disable('x-powered-by');
  // Changes on every deploy, so browsers fetch fresh CSS/JS instead of a cached old copy
  app.locals.assetVersion = Date.now().toString(36);

  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use(session({
    // Prune expired logins once a day rather than every 15 minutes, so the database can sleep
    store: new PgStore({ pool, createTableIfMissing: false, pruneSessionInterval: 24 * 60 * 60 }),
    secret: config.sessionSecret,
    name: 'appbot.sid',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 7 * 24 * 3600 * 1000 },
  }));

  // CSRF token for every form, plus one-time flash messages
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.path = req.path;
    if (req.method === 'POST') {
      const sent = String(req.body?._csrf || '');
      const ok = sent.length === req.session.csrf.length
        && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
      if (!ok) return res.status(403).render('error', { title: 'Expired form', message: 'That form expired. Go back, refresh the page and try again.', user: null });
    }
    next();
  });

  app.use(authRouter);
  app.use(requireLogin, (req, res, next) => { res.locals.guildOpts = () => guildOptions(res.locals.guild); next(); });
  app.use(staffRoutes);
  app.use(communityRoutes);
  app.use(extrasRoutes);
  app.use(routes);

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.', user: res.locals.user || null }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[web]', err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'The server hit an error. Check the logs on your host.', user: res.locals.user || null });
  });

  app.listen(config.port, () => console.log(`[web] dashboard on port ${config.port} (${config.publicUrl})`));
  return app;
}
