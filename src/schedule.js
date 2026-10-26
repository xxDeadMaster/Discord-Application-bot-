// Open/close schedules for applications (categories), worked out in the server's timezone.

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a moment in a timezone. weekday: 0 = Sunday. */
export function tzParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour) % 24, mm: Number(parts.minute), weekday: DAYS.indexOf(parts.weekday),
  };
}

/** The real moment when the wall clock in `tz` shows y-m-d hh:mm. */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

/** "2026-11-01T14:30" (typed in the server's timezone) -> Date, or null. */
export function parseLocalInput(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

/** Date -> "2026-11-01T14:30" in the server's timezone, for <input type="datetime-local">. */
export function toLocalInput(date, tz) {
  if (!date) return '';
  const p = tzParts(new Date(date), tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
}

export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return { hh: +m[1], mm: +m[2], text: `${m[1].padStart(2, '0')}:${m[2]}` };
}

export function formatWhen(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(date));
}

/** Monday-first order for showing days. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function time12(t) {
  const h = t.hh % 12 || 12;
  return `${h}${t.mm ? `:${String(t.mm).padStart(2, '0')}` : ''} ${t.hh < 12 ? 'AM' : 'PM'}`;
}

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: t.getUTCDay() };
}

/**
 * Per-day weekly hours: { "0": { start: "12:00", end: "20:00" }, ... } (0 = Sunday).
 * Falls back to the older single-window fields (weekly_days + weekly_start/end).
 */
export function weeklyHours(item) {
  const out = {};
  const src = item.weekly_hours && Object.keys(item.weekly_hours).length ? item.weekly_hours : null;
  if (src) {
    for (const [k, v] of Object.entries(src)) {
      const d = Number(k);
      const st = parseTime(v?.start);
      const en = parseTime(v?.end);
      if (d >= 0 && d <= 6 && st && en && st.text !== en.text) out[d] = { start: st, end: en };
    }
    return out;
  }
  const st = parseTime(item.weekly_start);
  const en = parseTime(item.weekly_end);
  if (st && en && st.text !== en.text) for (const d of item.weekly_days || []) if (d >= 0 && d <= 6) out[d] = { start: st, end: en };
  return out;
}

const mins = (t) => t.hh * 60 + t.mm;
const overnight = (w) => mins(w.end) <= mins(w.start);

/**
 * Whether an application is taking applications right now (ignores the on/off switch),
 * plus when that changes. Returns { open, changesAt: Date|null }.
 */
export function scheduleState(item, tz, now = new Date()) {
  const mode = item.schedule_mode || 'always';

  if (mode === 'dates') {
    const openAt = item.open_at ? new Date(item.open_at) : null;
    const closeAt = item.close_at ? new Date(item.close_at) : null;
    if (openAt && now < openAt) return { open: false, changesAt: openAt };
    if (closeAt && now >= closeAt) return { open: false, changesAt: null };
    return { open: true, changesAt: closeAt };
  }

  if (mode === 'weekly') {
    const hours = weeklyHours(item);
    if (!Object.keys(hours).length) return { open: false, changesAt: null };
    const p = tzParts(now, tz);
    const nowMin = p.hh * 60 + p.mm;
    const today = hours[p.weekday];
    const yest = hours[(p.weekday + 6) % 7];

    let endAt = null;
    if (today && !overnight(today) && nowMin >= mins(today.start) && nowMin < mins(today.end)) {
      endAt = { offset: 0, t: today.end };
    } else if (today && overnight(today) && nowMin >= mins(today.start)) {
      endAt = { offset: 1, t: today.end };
    } else if (yest && overnight(yest) && nowMin < mins(yest.end)) {
      endAt = { offset: 0, t: yest.end };
    }
    if (endAt) {
      const e = addDays(p.y, p.m, p.d, endAt.offset);
      return { open: true, changesAt: zonedToUtc(e.y, e.m, e.d, endAt.t.hh, endAt.t.mm, tz) };
    }
    for (let i = 0; i <= 7; i++) {
      const day = addDays(p.y, p.m, p.d, i);
      const w = hours[day.weekday];
      if (!w) continue;
      const start = zonedToUtc(day.y, day.m, day.d, w.start.hh, w.start.mm, tz);
      if (start > now) return { open: false, changesAt: start };
    }
    return { open: false, changesAt: null };
  }

  return { open: true, changesAt: null };
}

/** An application (category) is open right now: switched on and inside its schedule. */
export function isCategoryOpen(category, tz, now = new Date()) {
  return Boolean(category?.enabled) && scheduleState(category, tz, now).open;
}

/** Short human text for the dashboard, e.g. "Opens Sat, Nov 1, 12:00 PM". */
export function describeSchedule(role, tz, now = new Date()) {
  const mode = role.schedule_mode || 'always';
  const state = scheduleState(role, tz, now);
  if (mode === 'always') return { open: state.open, text: 'Always open while switched on' };
  if (mode === 'weekly') {
    const hours = weeklyHours(role);
    const n = Object.keys(hours).length;
    if (!n) return { open: false, text: 'Weekly schedule not finished' };
    const summary = `${n} day${n === 1 ? '' : 's'} a week`;
    if (state.open) return { open: true, text: `Open now until ${formatWhen(state.changesAt, tz)} · ${summary}`, changesAt: state.changesAt };
    return { open: false, text: state.changesAt ? `Opens ${formatWhen(state.changesAt, tz)} · ${summary}` : summary, changesAt: state.changesAt };
  }
  if (state.open) return { open: true, text: state.changesAt ? `Open until ${formatWhen(state.changesAt, tz)}` : 'Open', changesAt: state.changesAt };
  if (state.changesAt) return { open: false, text: `Opens ${formatWhen(state.changesAt, tz)}`, changesAt: state.changesAt };
  return { open: false, text: role.close_at ? `Closed since ${formatWhen(role.close_at, tz)}` : 'Closed' };
}

export function allTimezones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC'];
  }
}
