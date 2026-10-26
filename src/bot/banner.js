// Draws the black-to-blue Orbit banners (e.g. "STAFF APPLICATIONS") as PNG images.
// Text is turned into vector paths with opentype.js, so no system fonts are needed.
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import opentype from 'opentype.js';
import { AttachmentBuilder } from 'discord.js';

const require = createRequire(import.meta.url);
const titleFont = opentype.loadSync(require.resolve('@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff'));
const subFont = opentype.loadSync(require.resolve('@fontsource/nunito-sans/files/nunito-sans-latin-800-normal.woff'));

const W = 1200;
const H = 300;
const cache = new Map();

/** Fit text to a max width by shrinking the font size. Returns { path, width }. */
function textPath(font, text, size, maxWidth, x, y, { letterSpacing = 0, align = 'left' } = {}) {
  let s = size;
  const measure = (sz) => font.getAdvanceWidth(text, sz) + letterSpacing * (sz / size) * Math.max(text.length - 1, 0);
  while (s > 18 && measure(s) > maxWidth) s -= 2;
  const width = measure(s);
  let cursor = align === 'center' ? x - width / 2 : x;
  const parts = [];
  for (const ch of text) {
    const p = font.getPath(ch, cursor, y, s);
    parts.push(p.toPathData(2));
    cursor += font.getAdvanceWidth(ch, s) + letterSpacing * (s / size);
  }
  return { d: parts.join(' '), width, size: s };
}

/** Removes emoji and characters the fonts can't draw. */
function clean(text) {
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[^\x20-\x7E -ɏ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a long title into two lines at the space nearest the middle. */
function splitTitle(text) {
  const words = text.split(' ');
  if (words.length < 2) return [text];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

function bannerSvg(title, subtitle) {
  const text = clean(title).toUpperCase() || 'ORBIT';
  const sub = clean(subtitle).toUpperCase();
  let t = textPath(titleFont, text, 104, 760, 70, 168, { letterSpacing: 3 });
  let subY = 222;
  if (t.size < 72 && text.includes(' ')) {
    const [a, b] = splitTitle(text);
    const l1 = textPath(titleFont, a, 84, 760, 70, sub ? 120 : 136, { letterSpacing: 3 });
    const l2 = textPath(titleFont, b, l1.size, 760, 70, sub ? 196 : 214, { letterSpacing: 3 });
    t = { d: `${l1.d} ${l2.d}` };
    subY = 246;
  }
  const s = sub ? textPath(subFont, sub, 26, 760, 74, subY, { letterSpacing: 7 }) : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#04060C"/><stop offset="0.55" stop-color="#0A1B44"/><stop offset="1" stop-color="#1450C8"/></linearGradient>
    <radialGradient id="gl" cx="0.82" cy="0.45" r="0.55"><stop offset="0" stop-color="#4C9BFF" stop-opacity="0.55"/><stop offset="1" stop-color="#1F6FEB" stop-opacity="0"/></radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2F7BFF" stop-opacity="0"/><stop offset="0.45" stop-color="#58A6FF"/><stop offset="0.75" stop-color="#FFFFFF"/><stop offset="1" stop-color="#2F7BFF" stop-opacity="0.3"/></linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 0 40" fill="none" stroke="#58A6FF" stroke-width="1" opacity="0.07"/></pattern>
    <filter id="blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#gl)"/>
  <g fill="#FFFFFF"><circle cx="140" cy="46" r="2.5" opacity="0.55"/><circle cx="520" cy="34" r="2" opacity="0.5"/><circle cx="760" cy="270" r="2" opacity="0.4"/><circle cx="1130" cy="60" r="2.5" opacity="0.6"/>
  <path d="M1080 230 l4 11 l11 4 l-11 4 l-4 11 l-4 -11 l-11 -4 l11 -4 z" opacity="0.8"/></g>
  <ellipse cx="960" cy="160" rx="300" ry="62" transform="rotate(-12 960 160)" fill="none" stroke="url(#ring)" stroke-width="8"/>
  <g transform="translate(905 78)"><polygon points="55,0 110,32 55,64 0,32" fill="#FFFFFF"/><polygon points="0,32 55,64 55,128 0,96" fill="#3D8BFF"/><polygon points="110,32 110,96 55,128 55,64" fill="#0F3FA6"/></g>
  <circle cx="1238" cy="104" r="11" fill="#FFFFFF"/>
  <path d="${t.d}" fill="#3D8BFF" opacity="0.9" filter="url(#blur)"/>
  <path d="${t.d}" fill="#FFFFFF"/>
  ${s ? `<path d="${s.d}" fill="#9FCBFF"/>` : ''}
  <rect x="74" y="${s ? subY + 22 : 196}" width="64" height="6" rx="3" fill="#1F6FEB"/>
</svg>`;
}

/** PNG buffer for a banner. Cached per text. */
export function renderBanner(title, subtitle = '') {
  const key = `${title}\u0000${subtitle}`;
  if (cache.has(key)) return cache.get(key);
  const png = new Resvg(bannerSvg(title, subtitle), { fitTo: { mode: 'width', value: W } }).render().asPng();
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  cache.set(key, png);
  return png;
}

/** A Discord attachment for a banner, plus the URL to use in embed.setImage(). */
export function bannerAttachment(title, subtitle = '', name = 'banner.png') {
  try {
    return { file: new AttachmentBuilder(renderBanner(title, subtitle), { name }), url: `attachment://${name}` };
  } catch (err) {
    console.warn('[banner] could not render:', err.message);
    return null;
  }
}

/* ---------- Member cards (welcome / goodbye / boost) ---------- */

const CW = 1100;
const CH = 360;
const CARD_THEMES = {
  join: { ring: '#58A6FF', glow: '#3D8BFF', sub: '#9FCBFF', fill: '#1F6FEB', bg: ['#04060C', '#0A1B44', '#1450C8'] },
  leave: { ring: '#8592A8', glow: '#4A5670', sub: '#B8C2D3', fill: '#2C3547', bg: ['#04060C', '#10141E', '#273148'] },
  boost: { ring: '#F47FFF', glow: '#C86BFF', sub: '#F2C9FF', fill: '#7B3FE4', bg: ['#04060C', '#1E0F44', '#6B2FD6'] },
};

function cardSvg({ kind = 'join', heading, name, subtitle, avatarPng }) {
  const t = CARD_THEMES[kind] || CARD_THEMES.join;
  const head = textPath(titleFont, clean(heading).toUpperCase() || 'WELCOME', 40, 640, 380, 118, { letterSpacing: 8 });
  const who = textPath(titleFont, clean(name) || 'New member', 92, 660, 380, 214, { letterSpacing: 1 });
  const sub = subtitle ? textPath(subFont, clean(subtitle).toUpperCase(), 26, 640, 383, 270, { letterSpacing: 6 }) : null;
  const initial = textPath(titleFont, (clean(name) || '?').slice(0, 1).toUpperCase(), 110, 200, 190, 218, { align: 'center' });
  const avatar = avatarPng
    ? `<image href="data:image/png;base64,${avatarPng.toString('base64')}" x="80" y="70" width="220" height="220" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="190" cy="180" r="110" fill="${t.fill}"/><path d="${initial.d}" fill="#FFFFFF"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg[0]}"/><stop offset="0.55" stop-color="${t.bg[1]}"/><stop offset="1" stop-color="${t.bg[2]}"/></linearGradient>
    <radialGradient id="gl" cx="0.17" cy="0.5" r="0.4"><stop offset="0" stop-color="${t.glow}" stop-opacity="0.55"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 0 40" fill="none" stroke="#58A6FF" stroke-width="1" opacity="0.06"/></pattern>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.ring}" stop-opacity="0"/><stop offset="0.5" stop-color="${t.ring}"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.8"/></linearGradient>
    <clipPath id="av"><circle cx="190" cy="180" r="110"/></clipPath>
    <filter id="blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect width="${CW}" height="${CH}" fill="url(#bg)"/>
  <rect width="${CW}" height="${CH}" fill="url(#grid)"/>
  <rect width="${CW}" height="${CH}" fill="url(#gl)"/>
  <g fill="#FFFFFF"><circle cx="980" cy="60" r="2.5" opacity="0.6"/><circle cx="720" cy="40" r="2" opacity="0.45"/><circle cx="1040" cy="300" r="2" opacity="0.5"/>
  <path d="M1010 200 l4 11 l11 4 l-11 4 l-4 11 l-4 -11 l-11 -4 l11 -4 z" opacity="0.75"/></g>
  <ellipse cx="190" cy="180" rx="168" ry="44" transform="rotate(-14 190 180)" fill="none" stroke="url(#ring)" stroke-width="6" opacity="0.9"/>
  <circle cx="190" cy="180" r="118" fill="${t.bg[0]}" stroke="${t.ring}" stroke-width="6"/>
  ${avatar}
  <path d="${head.d}" fill="${t.sub}"/>
  <path d="${who.d}" fill="${t.glow}" opacity="0.85" filter="url(#blur)"/>
  <path d="${who.d}" fill="#FFFFFF"/>
  ${sub ? `<path d="${sub.d}" fill="${t.sub}"/>` : ''}
  <rect x="383" y="${sub ? 292 : 240}" width="64" height="6" rx="3" fill="${t.ring}"/>
</svg>`;
}

/** Fetches an avatar PNG (small, with a timeout). Returns null when it can't. */
export async function fetchAvatar(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length < 2_000_000 ? buf : null;
  } catch {
    return null;
  }
}

/** PNG of a member card. kind: join | leave | boost. */
export function renderCard(opts) {
  return new Resvg(cardSvg(opts), { fitTo: { mode: 'width', value: CW } }).render().asPng();
}

/** A Discord attachment for a member card, plus its attachment:// url. Null on error. */
export function cardAttachment(opts, name = 'card.png') {
  try {
    return { file: new AttachmentBuilder(renderCard(opts), { name }), url: `attachment://${name}` };
  } catch (err) {
    console.warn('[card] could not render:', err.message);
    return null;
  }
}
