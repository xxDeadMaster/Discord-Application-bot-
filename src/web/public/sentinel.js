/* Sentinel dashboard: polls /sentinel/live.json every 5 seconds and draws the overview. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const csrf = document.querySelector('meta[name=csrf]')?.content || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastEl = $('toast');
  let toastTimer = null;
  function toast(text, bad) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.className = `toast${bad ? ' bad' : ''}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
  }
  async function post(url, data) {
    const body = new URLSearchParams({ _csrf: csrf, ...data });
    const res = await fetch(url, { method: 'POST', body, headers: { accept: 'application/json' } });
    let json = {};
    try { json = await res.json(); } catch { json = { error: 'Something went wrong.' }; }
    if (!res.ok) throw new Error(json.error || 'Something went wrong.');
    return json;
  }

  /* Health chip (all Sentinel pages) */
  function setHealth(s) {
    const chip = $('healthChip');
    if (!chip) return;
    const ok = s && s.online;
    chip.classList.toggle('off', !ok);
    $('healthText').textContent = ok ? `Sentinel online · ${s.ping >= 0 ? `${s.ping} ms` : 'connecting'}` : 'Sentinel offline';
  }

  if (!$('status')) {
    // Other Sentinel pages: just keep the health chip current
    const tick = () => fetch('/sentinel/live.json', { headers: { accept: 'application/json' } }).then((r) => r.json()).then((d) => setHealth(d.sentinel)).catch(() => setHealth(null));
    tick(); setInterval(tick, 15000);
    return;
  }

  /* ---------- Confirm dialog ---------- */
  const scrim = $('scrim'), dlgInput = $('dlgInput'), dlgOk = $('dlgOk'), dlgReason = $('dlgReason');
  let onOk = null, typeWord = null, lastFocus = null;
  function confirmBox({ title, text, ok, word = null, reason = false, then }) {
    lastFocus = document.activeElement;
    $('dlgTitle').textContent = title;
    $('dlgText').innerHTML = text;
    dlgOk.textContent = ok;
    typeWord = word;
    $('dlgTypeWrap').hidden = !word;
    $('dlgReasonWrap').hidden = !reason;
    dlgReason.value = '';
    $('dlgLabel').textContent = word ? `Type ${word} to confirm` : '';
    dlgInput.value = '';
    dlgOk.disabled = Boolean(word);
    onOk = then;
    scrim.hidden = false;
    (reason ? dlgReason : word ? dlgInput : dlgOk).focus();
  }
  const closeBox = () => { scrim.hidden = true; lastFocus?.focus?.(); };
  dlgInput.addEventListener('input', () => { dlgOk.disabled = dlgInput.value.trim().toUpperCase() !== typeWord; });
  $('dlgCancel').addEventListener('click', closeBox);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeBox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !scrim.hidden) closeBox(); });
  dlgOk.addEventListener('click', async () => {
    if (dlgOk.disabled) return;
    const fn = onOk, typed = dlgInput.value, reason = dlgReason.value;
    dlgOk.disabled = true;
    try { await fn?.(typed, reason); closeBox(); } catch (err) { toast(err.message, true); dlgOk.disabled = false; }
  });

  /* ---------- State ---------- */
  let range = '1h', data = null, paused = false, waiting = 0, filter = 'all', lastFeedTop = 0, hoverI = null;
  const shown = new Set(['joins', 'blocked']);

  /* ---------- Status banner ---------- */
  const icons = {
    clear: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    raid: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
    lock: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  };
  let lockTimer = null, statusKey = '';
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0'); return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`; };
  const askLockdown = () => confirmBox({
    title: 'Start lockdown?', ok: 'Start lockdown', word: 'LOCKDOWN', reason: true,
    text: 'Members won\'t be able to send messages, make threads or react in any channel until you end it. Staff can still talk. Every channel is put back exactly as it was when you end it.',
    then: async (typed, reason) => { toast('Locking the server…'); const r = await post('/sentinel/lockdown', { on: '1', confirm: typed, reason }); toast(`🔒 Locked ${r.channels} channels${r.failed ? ` (${r.failed} failed)` : ''}.`); refresh(); },
  });
  const askEnd = () => confirmBox({
    title: 'End lockdown?', ok: 'End lockdown', text: 'Members can talk again. Every channel goes back to how it was.',
    then: async () => { toast('Unlocking…'); const r = await post('/sentinel/lockdown', { on: '0' }); toast(`🔓 Lockdown lifted${r.failed ? `, but ${r.failed} change(s) failed` : ''}.`, Boolean(r.failed)); refresh(); },
  });
  function renderStatus(d) {
    const k = d.sentinel ? d.status : (d.status === 'lock' ? 'lock' : 'off');
    const el = $('status');
    const key = JSON.stringify([k, d.lockdown?.channels, d.raid?.joins, Boolean(d.sentinel)]);
    if (key === statusKey) return;
    statusKey = key;
    el.className = `status st-${k}`;
    $('stIco').innerHTML = icons[k === 'off' ? 'raid' : k];
    clearInterval(lockTimer);
    const title = $('stTitle'), text = $('stText'), acts = $('stActs');
    const canAct = Boolean(d.sentinel?.online);
    const off = canAct ? '' : ' disabled title="Sentinel is offline"';
    if (k === 'off') {
      title.textContent = 'Sentinel offline';
      text.textContent = 'Sentinel isn\'t answering, so anti-nuke and the raid alarm aren\'t running right now. Check that the phone is on and connected.';
      acts.innerHTML = '';
    } else if (k === 'clear') {
      title.textContent = 'All clear';
      const on = Object.values(d.modules).filter((m) => m.on).length;
      text.textContent = `No raids or suspicious actions. Sentinel is watching ${on} protection${on === 1 ? '' : 's'}.`;
      acts.innerHTML = `<button class="btn btn-outline-red" id="aLock"${off}>Start lockdown…</button>`;
    } else if (k === 'raid') {
      title.textContent = 'Raid alert';
      text.textContent = `${d.raid.joins} people joined in a burst ${d.raid.minAgo} min ago${d.raid.newAccounts ? `, ${d.raid.newAccounts} with brand-new accounts` : ''}.`;
      acts.innerHTML = `<button class="btn btn-red" id="aLock"${off}>Start lockdown…</button>`;
    } else {
      title.innerHTML = 'Lockdown on <span class="timer" id="lockT"></span>';
      text.textContent = `Members can't send messages in ${d.lockdown.channels} channels. Staff can still talk. Started by ${d.lockdown.by}.`;
      acts.innerHTML = `<button class="btn" style="background:#fff;color:#7A1418;border-color:#fff;" id="aEnd"${off}>End lockdown…</button>`;
      const start = d.lockdown.since ? new Date(d.lockdown.since).getTime() : Date.now();
      const tick = () => { const t = $('lockT'); if (t) t.textContent = fmt(Date.now() - start); };
      tick(); lockTimer = setInterval(tick, 1000);
    }
    $('aLock')?.addEventListener('click', askLockdown);
    $('aEnd')?.addEventListener('click', askEnd);
  }

  /* ---------- Tiles ---------- */
  function renderTiles(d) {
    $('tJoins').textContent = d.joins10 ?? '–';
    $('tJoins').classList.toggle('dim', d.joins10 == null);
    $('tBlocked').textContent = d.blocked24;
    $('tRaidLine').textContent = `${d.modules.raid.joins} in ${d.modules.raid.seconds}s`;
    const s = d.sentinel;
    const meter = (value, label, pct, color) => `<div class="meter"><b>${esc(value)}</b><span>${esc(label)}</span><div class="bar"><i style="width:${Math.max(4, Math.min(100, pct))}%;background:${color}"></i></div></div>`;
    if (!s) {
      $('meters').innerHTML = '<div class="meter" style="grid-column: 1 / -1"><b style="color: var(--red-hot)">Offline</b><span>Sentinel isn\'t answering. Is the phone on?</span></div>';
    } else {
      const free = s.memory.freeMb, pctFree = (free / s.memory.totalMb) * 100;
      const memColor = free < 300 ? 'var(--red)' : free < 700 ? 'var(--warn)' : 'var(--ok)';
      const parts = [];
      if (s.phone && s.phone.battery != null) parts.push(meter(`${s.phone.battery}%${s.phone.charging ? ' ⚡' : ''}`, 'Battery', s.phone.battery, s.phone.battery < 25 ? 'var(--red)' : 'var(--ok)'));
      if (s.phone && s.phone.temp != null) parts.push(meter(`${Math.round(s.phone.temp)}°C`, 'Phone temp', (s.phone.temp / 50) * 100, s.phone.temp > 42 ? 'var(--red)' : s.phone.temp > 37 ? 'var(--warn)' : 'var(--ok)'));
      parts.push(meter(free >= 1024 ? `${(free / 1024).toFixed(1)} GB` : `${free} MB`, 'Free memory', pctFree, memColor));
      if (parts.length < 3) parts.push(meter(s.uptimeMin >= 1440 ? `${Math.floor(s.uptimeMin / 1440)}d` : s.uptimeMin >= 60 ? `${Math.floor(s.uptimeMin / 60)}h` : `${s.uptimeMin}m`, 'Sentinel up', Math.min(100, s.uptimeMin / 14.4), 'var(--ok)'));
      if (parts.length < 3) parts.push(meter(`${s.ping >= 0 ? s.ping : '–'} ms`, 'Ping', 100 - Math.min(100, s.ping / 5), s.ping > 300 ? 'var(--warn)' : 'var(--ok)'));
      $('meters').innerHTML = parts.join('');
    }
    const li = d.lastIncident;
    if (li) {
      const m = li.minAgo;
      $('tLast').innerHTML = m < 60 ? `${m} <small>min ago</small>` : m < 2880 ? `${Math.round(m / 60)} <small>hours ago</small>` : `${Math.round(m / 1440)} <small>days ago</small>`;
      $('tLastNote').textContent = li.summary;
      $('tLast').classList.remove('dim');
    } else {
      $('tLast').textContent = 'None';
      $('tLast').classList.add('dim');
      $('tLastNote').textContent = 'Nothing has happened yet.';
    }
  }

  /* ---------- Needs attention ---------- */
  function renderAttn(d) {
    const list = d.attention;
    $('attnCount').textContent = list.length || '';
    const side = $('attnSide');
    if (side) { side.hidden = !list.length; side.textContent = list.length; }
    if (!list.length) {
      $('attn').innerHTML = '<div class="calm"><span class="ok-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></span><span>Nothing needs you right now<small>Sentinel puts anything urgent here.</small></span></div>';
      return;
    }
    $('attn').innerHTML = list.map((a) => `<div class="alert-item" style="margin-bottom:8px">
        <p><b>Anti-nuke stopped ${esc(a.who)}</b><br><span style="color: var(--text-2); font-size: 13px;">${esc(a.count)} ${esc(a.label || 'actions')} in a minute · ${a.kicked ? 'bot kicked' : `${a.roles} role${a.roles === 1 ? '' : 's'} removed`} · ${a.minAgo < 60 ? `${a.minAgo} min ago` : `${Math.round(a.minAgo / 60)} h ago`}</span></p>
        <div class="row">
          <button class="btn btn-sm" data-act="keep" data-id="${a.id}">Keep removed</button>
          ${a.roles && !a.kicked ? `<button class="btn btn-sm" data-act="restore" data-id="${a.id}" data-who="${esc(a.who)}" data-n="${a.roles}">Restore roles…</button>` : ''}
          <button class="btn btn-sm btn-outline-red" data-act="ban" data-id="${a.id}" data-who="${esc(a.who)}">Ban…</button>
        </div></div>`).join('');
  }
  $('attn').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const { act, id, who, n } = b.dataset;
    const url = `/sentinel/attention/${id}/${act}`;
    if (act === 'keep') { post(url, {}).then(() => { toast('Marked as handled.'); refresh(); }).catch((err) => toast(err.message, true)); return; }
    if (act === 'restore') confirmBox({ title: `Restore ${who}'s roles?`, ok: 'Restore roles', text: `Only do this if it was a false alarm. They get back the <b>${esc(n)} role${n === '1' ? '' : 's'}</b> Sentinel removed.`, then: async () => { const r = await post(url, {}); toast(`Restored ${r.restored} role(s).`); refresh(); } });
    if (act === 'ban') confirmBox({ title: `Ban ${who}?`, ok: 'Ban', word: 'BAN', text: 'They are removed from the server and can\'t rejoin.', then: async (typed) => { await post(url, { confirm: typed }); toast(`${who} was banned.`); refresh(); } });
  });

  /* ---------- Staff ---------- */
  function renderStaff(d) {
    const dot = { online: 'd-on', idle: 'd-idle', dnd: 'd-dnd' };
    const on = d.staff.filter((s) => s.status !== 'offline').length;
    $('staffCount').textContent = `${on} online`;
    $('staff').innerHTML = d.staff.slice(0, 8).map((s) => `<li><span class="ini">${esc((s.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}${dot[s.status] ? `<span class="dot ${dot[s.status]}"></span>` : ''}</span><span class="nm" title="${esc(s.name)}" style="${s.status === 'offline' ? 'color: var(--muted)' : ''}">${esc(s.name)}</span><span class="role" title="${esc(s.role)}">${esc(s.role)}</span></li>`).join('') || '<li class="feed-empty">No staff role set in Orbit.</li>';
  }

  /* ---------- Modules ---------- */
  function renderMods(d) {
    const m = d.modules;
    const rows = [
      { key: 'antinuke', name: 'Anti-nuke', on: m.antinuke.on, sub: `3+ fast deletes/bans → remove roles${m.antinuke.trusted ? ` · ${m.antinuke.trusted} trusted` : ''}`, tog: true },
      { key: 'raid', name: 'Raid alarm', on: m.raid.on, sub: `${m.raid.joins} joins in ${m.raid.seconds}s → alert${m.raid.auto ? ' + lockdown' : ''}`, tog: true },
      { key: 'trap', name: 'Spam trap', on: m.trap.on, sub: m.trap.on ? `#${m.trap.channel || 'unknown'} · run by ${m.trap.bot === 'sentinel' ? 'Sentinel' : 'Orbit'}` : 'Off · pick a channel in Orbit', tog: false },
      { key: 'gif', name: 'GIF blocker', on: m.gif.on, sub: `${m.gif.allowed.length ? `Allowed in ${m.gif.allowed.map((c) => `#${c}`).join(', ')}` : 'Blocked everywhere'} · run by ${m.gif.bot === 'sentinel' ? 'Sentinel' : 'Orbit'}`, tog: true },
    ];
    $('modCount').textContent = `${rows.filter((r) => r.on).length} / ${rows.length} on`;
    $('mods').innerHTML = rows.map((r) => `<li class="${r.on ? '' : 'is-off'}"><span><span class="n">${esc(r.name)}</span><span class="s">${esc(r.sub)}</span></span>${r.tog
      ? `<button class="tog ${r.on ? '' : 'off'}" data-mod="${r.key}" data-name="${esc(r.name)}" aria-pressed="${r.on}" aria-label="${esc(r.name)}"></button>`
      : '<a class="link" href="/moderation">Change</a>'}</li>`).join('');
  }
  $('mods').addEventListener('click', (e) => {
    const t = e.target.closest('.tog');
    if (!t) return;
    const on = t.classList.contains('off');
    const send = async (typed) => { await post('/sentinel/modules', { module: t.dataset.mod, on: on ? '1' : '0', confirm: typed || '' }); toast(`${t.dataset.name} turned ${on ? 'on' : 'off'}.`); refresh(); };
    if (on) { send().catch((err) => toast(err.message, true)); return; }
    const nuke = t.dataset.mod === 'antinuke';
    confirmBox({ title: `Turn off ${t.dataset.name}?`, ok: 'Turn off', word: nuke ? 'OFF' : null, text: `Sentinel stops doing this until you turn it back on.${nuke ? ' <b>A hacked staff account could then delete channels freely.</b>' : ''}`, then: send });
  });

  /* ---------- Chart ---------- */
  const W = 600, H = 170;
  const COLORS = { joins: '#5BA7FF', leaves: '#B7A9AB', blocked: '#E5484D', mod: '#FF9F43' };
  const NAMES = { joins: 'Joins', leaves: 'Leaves', blocked: 'Messages blocked', mod: 'Mod actions' };
  const LABEL = { '1h': '60 min ago', '24h': '24 hours ago', '7d': '7 days ago' };
  function drawChart() {
    if (!data) return;
    const series = data.chart, n = series.joins.length;
    const raidPerMin = range === '1h' && data.modules.raid.on ? (data.modules.raid.joins * 60) / data.modules.raid.seconds : null;
    let max = 4;
    for (const k of shown) for (const v of series[k]) max = Math.max(max, v);
    if (raidPerMin && shown.has('joins')) max = Math.max(max, raidPerMin * 1.15);
    max = Math.ceil(max * 1.1);
    const xAt = (i) => (n > 1 ? (i / (n - 1)) * W : 0), yAt = (v) => H - 4 - (v / max) * (H - 12);
    let body = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="0" x2="${W}" y1="${yAt(max * f)}" y2="${yAt(max * f)}" stroke="#2A171A" stroke-width="1"/>`).join('');
    for (const k of ['leaves', 'mod', 'blocked', 'joins']) {
      if (!shown.has(k)) continue;
      const line = series[k].map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
      if (k === 'joins') body += `<path d="${line} L${W},${H - 4} L0,${H - 4} Z" fill="rgba(91,167,255,.10)"/>`;
      body += `<path d="${line}" fill="none" stroke="${COLORS[k]}" stroke-width="${k === 'joins' ? 2.4 : 1.9}" stroke-linejoin="round" ${k === 'leaves' ? 'stroke-dasharray="3 3"' : ''}/>`;
    }
    const tl = $('thLabel');
    const showTh = raidPerMin && shown.has('joins');
    if (showTh) body += `<line x1="0" x2="${W}" y1="${yAt(raidPerMin)}" y2="${yAt(raidPerMin)}" stroke="#9CCBFF" stroke-width="1.4" stroke-dasharray="7 5"/>`;
    if (hoverI !== null) body += `<line x1="${xAt(hoverI)}" x2="${xAt(hoverI)}" y1="0" y2="${H}" stroke="#D8C7C9" stroke-width="1" stroke-dasharray="2 3"/>`;
    $('chart').innerHTML = body;
    tl.style.display = showTh ? '' : 'none';
    if (showTh) { tl.textContent = `raid line · ${Math.round(raidPerMin * 10) / 10}/min`; tl.style.top = `${Math.max(0, (yAt(raidPerMin) / H) * $('chartWrap').clientHeight - 16)}px`; }
    $('axL').textContent = LABEL[range];
  }
  document.querySelectorAll('.ser').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (shown.has(k) && shown.size > 1) shown.delete(k); else shown.add(k);
    b.classList.toggle('on', shown.has(k)); b.setAttribute('aria-pressed', String(shown.has(k)));
    drawChart();
  }));
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.r;
    document.querySelectorAll('.seg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    refresh();
  }));
  const wrap = $('chartWrap'), tip = $('tip');
  wrap.addEventListener('mousemove', (e) => {
    if (!data) return;
    const r = wrap.getBoundingClientRect(), n = data.chart.joins.length;
    hoverI = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    const back = n - 1 - hoverI;
    const when = !back ? (range === '1h' ? 'This minute' : 'Now') : range === '1h' ? `${back} min ago` : range === '24h' ? `${back} h ago` : `${back * 4} h ago`;
    tip.innerHTML = `<b>${when}</b>` + [...shown].map((k) => `<div><i style="background:${COLORS[k]}"></i>${NAMES[k]}<span>${data.chart[k][hoverI]}</span></div>`).join('');
    tip.hidden = false;
    const left = (hoverI / (n - 1)) * r.width;
    tip.style.left = `${left > r.width - 190 ? left - 180 : left + 12}px`;
    drawChart();
  });
  wrap.addEventListener('mouseleave', () => { hoverI = null; tip.hidden = true; drawChart(); });

  /* ---------- Feed ---------- */
  const AVC = ['#5B2A86', '#1F6FEB', '#2F7D57', '#4B5A73', '#B36B00', '#3A4A6B', '#6B3FA0'];
  const avColor = (name) => AVC[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVC.length];
  const when = (at) => { const s = Math.round((Date.now() - at) / 1000); return s < 20 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const FEED_F = { raid: 'join' };
  function renderFeed() {
    if (!data) return;
    const list = data.feed.filter((e) => filter === 'all' || e.f === filter || FEED_F[e.f] === filter).slice(0, 8);
    $('feed').innerHTML = !data.sentinel ? '<li class="feed-empty">Sentinel is offline, so there\'s no live activity. Its saved alerts are in the Security log.</li>'
      : list.length ? list.map((e) => `<li><span class="av" style="background:${avColor(e.who)}">${esc((String(e.who).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}<span class="sev sev-${esc(e.sev)}"></span></span><span>${esc(e.text)}<br><span class="meta">${esc(e.meta)}</span></span><span class="t">${when(e.at)}</span></li>`).join('')
        : `<li class="feed-empty">${filter === 'all' ? 'Quiet so far. Joins, blocked messages and alerts show up here as they happen (since Sentinel last started).' : 'Nothing of this type yet.'}</li>`;
  }
  document.querySelectorAll('#filters button').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
    renderFeed();
  }));
  const feedCard = $('feedCard'), pauseBtn = $('pauseBtn');
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
    feedCard.classList.toggle('is-paused', paused);
    feedCard.querySelector('.paused-note').textContent = 'Paused · new events are waiting';
    if (!paused) { waiting = 0; renderFeed(); }
  });

  /* ---------- Polling ---------- */
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(`/sentinel/live.json?range=${range}`, { headers: { accept: 'application/json' } });
      if (res.status === 401 || res.redirected) { location.reload(); return; }
      const d = await res.json();
      const top = d.feed[0]?.id || 0;
      const newOnes = d.feed.filter((e) => e.id > lastFeedTop).length;
      data = d;
      setHealth(d.sentinel);
      renderStatus(d); renderTiles(d); renderAttn(d); renderStaff(d); renderMods(d);
      if (hoverI === null) drawChart();
      if (paused && lastFeedTop && newOnes) { waiting += newOnes; feedCard.querySelector('.paused-note').textContent = `Paused · ${waiting} new event${waiting === 1 ? '' : 's'} waiting`; } else if (!paused) renderFeed();
      lastFeedTop = Math.max(lastFeedTop, top);
    } catch {
      setHealth(null);
    } finally {
      busy = false;
    }
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}());
