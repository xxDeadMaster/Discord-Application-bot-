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

export function time12(t) {
  const h = t.hh % 12 || 12;
  return `${h}${t.mm ? `:${String(t.mm).padStart(2, '0')}` : ''} ${t.hh < 12 ? 'AM' : 'PM'}`;
}

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: t.getUTCDay() };
}

function weeklyWindow(role) {
  const start = parseTime(role.weekly_start);
  const end = parseTime(role.weekly_end);
  const days = (role.weekly_days || []).map(Number).filter((n) => n >= 0 && n <= 6);
  if (!start || !end || !days.length) return null;
  const startMin = start.hh * 60 + start.mm;
  const endMin = end.hh * 60 + end.mm;
  return { start, end, days, startMin, endMin, overnight: endMin <= startMin };
}

/**
 * Whether a role is taking applications right now (ignores the on/off switch),
 * plus when that changes. Returns { open, changesAt: Date|null }.
 */
export function scheduleState(role, tz, now = new Date()) {
  const mode = role.schedule_mode || 'always';

  if (mode === 'dates') {
    const openAt = role.open_at ? new Date(role.open_at) : null;
    const closeAt = role.close_at ? new Date(role.close_at) : null;
    if (openAt && now < openAt) return { open: false, changesAt: openAt };
    if (closeAt && now >= closeAt) return { open: false, changesAt: null };
    return { open: true, changesAt: closeAt };
  }

  if (mode === 'weekly') {
    const w = weeklyWindow(role);
    if (!w) return { open: false, changesAt: null };
    const p = tzParts(now, tz);
    const nowMin = p.hh * 60 + p.mm;
    const yesterday = (p.weekday + 6) % 7;

    let openNow = false;
    let endDay = null; // offset in days from today when the current window ends
    if (!w.overnight) {
      if (w.days.includes(p.weekday) && nowMin >= w.startMin && nowMin < w.endMin) { openNow = true; endDay = 0; }
    } else if (w.days.includes(p.weekday) && nowMin >= w.startMin) {
      openNow = true; endDay = 1;
    } else if (w.days.includes(yesterday) && nowMin < w.endMin) {
      openNow = true; endDay = 0;
    }

    if (openNow) {
      const e = addDays(p.y, p.m, p.d, endDay);
      return { open: true, changesAt: zonedToUtc(e.y, e.m, e.d, w.end.hh, w.end.mm, tz) };
    }
    for (let i = 0; i <= 7; i++) {
      const day = addDays(p.y, p.m, p.d, i);
      if (!w.days.includes(day.weekday)) continue;
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
    const w = weeklyWindow(role);
    if (!w) return { open: false, text: 'Weekly schedule not finished' };
    const days = w.days.slice().sort().map((d) => DAYS[d]).join(', ');
    const window = `${days}, ${time12(w.start)}–${time12(w.end)}`;
    if (state.open) return { open: true, text: `Open now · ${window}`, changesAt: state.changesAt };
    return { open: false, text: state.changesAt ? `Opens ${formatWhen(state.changesAt, tz)} · ${window}` : window, changesAt: state.changesAt };
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
