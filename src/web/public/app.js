// Local times
document.querySelectorAll('time[datetime]').forEach((el) => {
  const d = new Date(el.getAttribute('datetime'));
  if (Number.isNaN(d.getTime())) return;
  el.textContent = d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  el.title = d.toString();
});

// "Are you sure?" on destructive forms
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
});

// Show/hide panels (e.g. "Edit category")
document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.toggle);
    if (!target) return;
    target.hidden = !target.hidden;
    btn.setAttribute('aria-expanded', String(!target.hidden));
    if (!target.hidden) target.querySelector('input, textarea, select')?.focus();
  });
});

// Bulk select + delete on tables
document.querySelectorAll('form[data-bulk]').forEach((form) => {
  const all = form.querySelector('[data-select-all]');
  const boxes = () => [...form.querySelectorAll('[data-row-check]')];
  const countEl = form.querySelector('[data-bulk-count]');
  const submit = form.querySelector('[data-bulk-submit]');
  const idle = countEl?.textContent;
  const update = () => {
    const checked = boxes().filter((b) => b.checked);
    boxes().forEach((b) => b.closest('tr')?.classList.toggle('selected', b.checked));
    if (countEl) countEl.textContent = checked.length ? `${checked.length} selected` : idle;
    if (submit) submit.disabled = !checked.length;
    if (all) {
      all.checked = checked.length > 0 && checked.length === boxes().length;
      all.indeterminate = checked.length > 0 && checked.length < boxes().length;
      all.disabled = !boxes().length;
    }
  };
  all?.addEventListener('change', () => { boxes().forEach((b) => { b.checked = all.checked; }); update(); });
  form.addEventListener('change', (e) => { if (e.target.matches('[data-row-check]')) update(); });
  form.addEventListener('submit', (e) => {
    const n = boxes().filter((b) => b.checked).length;
    const msg = (form.dataset.confirmBulk || 'Delete {n} item(s)?').replace('{n}', n);
    if (!n || !window.confirm(msg)) e.preventDefault();
  });
  update();
});

// Question editor
const list = document.querySelector('[data-questions]');
if (list) {
  const template = document.querySelector('[data-question-template]');
  const addBtn = document.querySelector('[data-add-question]');
  const countEl = document.querySelector('[data-q-count]');
  const max = Number(list.dataset.max) || 20;

  const renumber = () => {
    const items = [...list.querySelectorAll('.question')];
    items.forEach((li, i) => {
      const ta = li.querySelector('textarea');
      const label = li.querySelector('label');
      ta.id = `q-${i}`;
      label.setAttribute('for', ta.id);
      label.textContent = `Question ${i + 1}`;
    });
    if (countEl) countEl.textContent = items.length;
    addBtn.disabled = items.length >= max;
  };

  addBtn.addEventListener('click', () => {
    if (list.querySelectorAll('.question').length >= max) return;
    list.appendChild(template.content.cloneNode(true));
    renumber();
    list.lastElementChild.querySelector('textarea').focus();
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('.question');
    if (btn.hasAttribute('data-remove')) {
      li.remove();
    } else if (btn.dataset.move === 'up' && li.previousElementSibling) {
      list.insertBefore(li, li.previousElementSibling);
    } else if (btn.dataset.move === 'down' && li.nextElementSibling) {
      list.insertBefore(li.nextElementSibling, li);
    }
    renumber();
    btn.focus();
  });

  if (!list.querySelector('.question')) addBtn.click();
  renumber();
}

// Schedule editor: show only the fields for the picked mode
document.querySelectorAll('[data-schedule]').forEach((box) => {
  const sync = () => {
    const mode = box.querySelector('input[name="schedule_mode"]:checked')?.value || 'always';
    box.querySelectorAll('[data-mode-panel]').forEach((p) => { p.hidden = p.dataset.modePanel !== mode; });
  };
  box.addEventListener('change', sync);
  sync();
});

// Filter a long checkbox list (blocked roles)
document.querySelectorAll('[data-filter-target]').forEach((input) => {
  const list = document.getElementById(input.dataset.filterTarget);
  if (!list) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    list.querySelectorAll('[data-filter-text]').forEach((el) => { el.hidden = q && !el.dataset.filterText.includes(q); });
  });
  const count = document.querySelector('[data-blocked-count]');
  list.addEventListener('change', () => { if (count) count.textContent = list.querySelectorAll('input:checked').length; });
});

// Weekly hours: enable a day's times only when the day is on; copy Monday's hours
document.querySelectorAll('[data-day-row]').forEach((row) => {
  const toggle = row.querySelector('[data-day-toggle]');
  const times = row.querySelectorAll('input[type=time]');
  const sync = () => {
    row.classList.toggle('on', toggle.checked);
    times.forEach((t) => { t.disabled = !toggle.checked; });
    if (toggle.checked && !times[0].value) times[0].value = '12:00';
    if (toggle.checked && !times[1].value) times[1].value = '20:00';
  };
  toggle.addEventListener('change', sync);
});
document.querySelectorAll('[data-copy-monday]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const grid = btn.closest('[data-mode-panel]').querySelector('.week-grid');
    const rows = [...grid.querySelectorAll('[data-day-row]')];
    const [ms, me] = rows[0].querySelectorAll('input[type=time]');
    rows.slice(1).forEach((r) => {
      if (!r.querySelector('[data-day-toggle]').checked) return;
      const [s, e] = r.querySelectorAll('input[type=time]');
      s.value = ms.value; e.value = me.value;
    });
  });
});

/* ---------- Welcome page: click a fill-in to add it to the last message box used ---------- */
(() => {
  const targets = document.querySelectorAll('[data-ph-target]');
  if (!targets.length) return;
  let last = targets[0];
  targets.forEach((t) => t.addEventListener('focus', () => { last = t; }));
  document.querySelectorAll('[data-insert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.insert;
      const start = last.selectionStart ?? last.value.length;
      const end = last.selectionEnd ?? last.value.length;
      last.value = last.value.slice(0, start) + code + last.value.slice(end);
      last.focus();
      last.selectionStart = last.selectionEnd = start + code.length;
    });
  });
})();

/* ---------- Polls page: add option rows ---------- */
document.querySelectorAll('[data-add-option]').forEach((btn) => {
  const list = btn.parentElement.querySelector('[data-poll-options]');
  const max = Number(list.dataset.max || 10);
  const sync = () => { btn.hidden = list.children.length >= max; };
  btn.addEventListener('click', () => {
    const n = list.children.length + 1;
    if (n > max) return;
    const row = document.createElement('div');
    row.className = 'poll-opt';
    row.innerHTML = `<span class="poll-num" aria-hidden="true">${n}</span><label class="sr" for="opt-${n - 1}">Option ${n}</label><input id="opt-${n - 1}" name="options" maxlength="80">`;
    list.appendChild(row);
    row.querySelector('input').focus();
    sync();
  });
  sync();
});

/* ---------- Show times in the viewer's own timezone ---------- */
document.querySelectorAll('time[data-local]').forEach((el) => {
  const d = new Date(el.dataset.local);
  if (!Number.isNaN(d.getTime())) el.textContent = d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
});

/* ---------- Page tabs: [data-tabs] bar with [data-tab] buttons, panels [data-tab-panel] ---------- */
document.querySelectorAll('[data-tabs]').forEach((bar) => {
  const key = `orbit-tab:${bar.dataset.tabs}`;
  const tabs = [...bar.querySelectorAll('[data-tab]')];
  const panelOf = (t) => document.getElementById(t.getAttribute('aria-controls'));
  const input = document.querySelector(`input[data-tab-input="${bar.dataset.tabs}"]`);
  const show = (tab, { focus = false, remember = true } = {}) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panelOf(t)?.classList.toggle('active', on);
    });
    if (input) input.value = tab.dataset.tab;
    // Keep the chosen tab visible when the bar scrolls sideways (phones)
    bar.scrollLeft = Math.max(0, tab.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2);
    if (remember) { try { localStorage.setItem(key, tab.dataset.tab); } catch { /* private mode */ } }
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => {
      show(t);
      history.replaceState(null, '', `#${t.dataset.tab}`);
    });
    t.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) { e.preventDefault(); show(tabs[(i + step + tabs.length) % tabs.length], { focus: true }); }
    });
  });
  // Pick the first tab to show: from the link (#tickets or an element inside a tab), else the last one used
  const hash = decodeURIComponent(location.hash.slice(1));
  let start = tabs.find((t) => t.dataset.tab === hash);
  if (!start && hash) {
    const el = document.getElementById(hash);
    const panel = el?.closest('[data-tab-panel]');
    start = tabs.find((t) => panelOf(t) === panel);
  }
  if (!start) {
    let saved = null;
    try { saved = localStorage.getItem(key); } catch { /* private mode */ }
    start = tabs.find((t) => t.dataset.tab === saved) || tabs[0];
  }
  if (start) show(start, { remember: false });
});

/* ---------- Review page: "Show questions only" toggle for long applications ---------- */
document.querySelectorAll('[data-collapse-all]').forEach((btn) => {
  const list = document.getElementById(btn.dataset.collapseAll);
  btn.addEventListener('click', () => {
    const on = list.classList.toggle('qs-only');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Show answers' : 'Show questions only';
  });
});

/* ---------- Question boxes: one line, grow to fit the text ---------- */
(() => {
  const list = document.querySelector('[data-questions]');
  if (!list) return;
  const fit = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  list.querySelectorAll('textarea').forEach(fit);
  list.addEventListener('input', (e) => { if (e.target.matches('textarea')) fit(e.target); });
  new MutationObserver(() => list.querySelectorAll('textarea').forEach(fit)).observe(list, { childList: true });
  window.addEventListener('resize', () => list.querySelectorAll('textarea').forEach(fit));
})();

/* ---------- Server stats: add/remove counter rows, default name per kind ---------- */
(() => {
  const list = document.querySelector('[data-counter-list]');
  if (!list) return;
  const addBtn = document.querySelector('[data-add-counter]');
  const sync = () => { addBtn.hidden = list.querySelectorAll('[data-counter-row]').length >= 10; };
  addBtn.addEventListener('click', () => {
    const rows = list.querySelectorAll('[data-counter-row]');
    const copy = rows[rows.length - 1].cloneNode(true);
    const n = Date.now();
    copy.querySelectorAll('select, input').forEach((el) => {
      if (el.name === 'kind') el.selectedIndex = 0; else if (el.tagName === 'SELECT') el.value = ''; else el.value = '';
      const label = copy.querySelector(`label[for="${el.id}"]`);
      el.id = `${el.name}-${n}`;
      if (label) label.setAttribute('for', el.id);
    });
    copy.querySelectorAll('.help').forEach((h) => h.remove());
    const kind = copy.querySelector('[data-kind]');
    copy.querySelector('[data-template]').placeholder = kind.selectedOptions[0].dataset.template;
    list.appendChild(copy);
    sync();
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-counter]');
    if (!btn) return;
    const rows = list.querySelectorAll('[data-counter-row]');
    const row = btn.closest('[data-counter-row]');
    if (rows.length === 1) { row.querySelectorAll('select, input').forEach((el) => { el.value = el.name === 'kind' ? 'members' : ''; }); } else row.remove();
    sync();
  });
  list.addEventListener('change', (e) => {
    if (!e.target.matches('[data-kind]')) return;
    const tpl = e.target.closest('[data-counter-row]').querySelector('[data-template]');
    tpl.placeholder = e.target.selectedOptions[0].dataset.template;
  });
  sync();
})();

/* ---------- Role buttons: add/remove button rows ---------- */
document.querySelectorAll('[data-menu-items]').forEach((list) => {
  const addBtn = list.parentElement.querySelector('[data-add-item]');
  const max = Number(list.dataset.max || 10);
  const sync = () => { addBtn.hidden = list.querySelectorAll('[data-menu-item]').length >= max; };
  addBtn.addEventListener('click', () => {
    const rows = list.querySelectorAll('[data-menu-item]');
    const copy = rows[rows.length - 1].cloneNode(true);
    copy.querySelectorAll('input').forEach((el) => { el.value = ''; });
    copy.querySelector('select').value = '';
    list.appendChild(copy);
    copy.querySelector('select').focus();
    sync();
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-item]');
    if (!btn) return;
    const rows = list.querySelectorAll('[data-menu-item]');
    const row = btn.closest('[data-menu-item]');
    if (rows.length === 1) { row.querySelectorAll('input').forEach((el) => { el.value = ''; }); row.querySelector('select').value = ''; } else row.remove();
    sync();
  });
  sync();
});

/* ---------- v3 shell: theme toggle, phone menu, remembered sidebar groups, one open menu at a time ---------- */
(() => {
  const root = document.documentElement;
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('orbit-theme', next); } catch { /* private mode */ }
    });
  });
  const sidebar = document.getElementById('sidebar');
  const scrim = document.querySelector('[data-close-sidebar]');
  const setOpen = (open) => { sidebar?.classList.toggle('open', open); if (scrim) scrim.hidden = !open; };
  document.querySelectorAll('[data-open-sidebar]').forEach((b) => b.addEventListener('click', () => setOpen(true)));
  scrim?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  // Sidebar groups remember open/closed (the group with the current page always opens)
  document.querySelectorAll('.side-group').forEach((g) => {
    const key = `orbit-group:${g.dataset.group}`;
    let saved = null;
    try { saved = localStorage.getItem(key); } catch { /* ignore */ }
    if (saved === 'closed' && !g.querySelector('.side-link.active')) g.open = false;
    g.addEventListener('toggle', () => { try { localStorage.setItem(key, g.open ? 'open' : 'closed'); } catch { /* ignore */ } });
  });
  // Close dropdown menus when clicking elsewhere
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
})();

/* ---------- Overview: filter the activity feed (shows the newest few that match) ---------- */
document.querySelectorAll('[data-activity-filter]').forEach((select) => {
  const list = document.querySelector('[data-activity-list]');
  if (!list) return;
  const show = Number(list.dataset.show) || 7;
  select.addEventListener('change', () => {
    let shown = 0;
    list.querySelectorAll('[data-kind]').forEach((li) => {
      const match = select.value === 'all' || li.dataset.kind === select.value;
      li.hidden = !(match && shown < show);
      if (match) shown++;
    });
  });
});

/* ---------- Server overview: hover chart, metric tiles, 7d / 30d ---------- */
document.querySelectorAll('[data-server-overview]').forEach((card) => {
  let days = [];
  try { days = JSON.parse(card.querySelector('[data-so-data]')?.textContent || '[]'); } catch { days = []; }
  const LABEL = { members: 'Members', humans: 'People', bots: 'Bots', channels: 'Channels', roles: 'Roles', boosts: 'Boosts' };
  const chart = card.querySelector('[data-so-chart]');
  const svg = chart.querySelector('svg');
  const tip = chart.querySelector('.so-tip');
  const tiles = [...card.querySelectorAll('[data-metric]')];
  const nf = (n) => Number(n || 0).toLocaleString('en-US');
  const sign = (n) => (n > 0 ? `+${nf(n)}` : n < 0 ? `−${nf(-n)}` : 'no change');
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const arrow = (n) => (n > 0 ? `↑ ${nf(n)}` : n < 0 ? `↓ ${nf(-n)}` : '');
  const asDate = (d) => new Date(`${d}T12:00:00Z`);
  const longDay = (d) => asDate(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const shortDay = (d) => asDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  let metric = 'members';
  let range = 7;
  let points = [];
  let data = [];

  function draw() {
    data = days.slice(-range);
    const color = getComputedStyle(tiles.find((t) => t.dataset.metric === metric)).getPropertyValue('--c').trim() || '#3D8BFF';
    // Header + tiles for this range
    const first = data[0];
    const last = data[data.length - 1];
    if (!last) return;
    const diff = data.length > 1 ? last[metric] - first[metric] : null;
    card.querySelector('[data-so-big]').textContent = nf(last[metric]);
    const chg = card.querySelector('[data-so-chg]');
    chg.textContent = diff ? arrow(diff) : '';
    chg.className = `so-chg ${cls(diff)}`;
    card.querySelector('[data-so-sub]').textContent = diff == null ? LABEL[metric] : `${LABEL[metric]} · ${sign(diff)} in the last ${range} days`;
    tiles.forEach((t) => {
      const k = t.dataset.metric;
      const d = data.length > 1 ? last[k] - first[k] : 0;
      t.classList.toggle('on', k === metric);
      t.setAttribute('aria-pressed', String(k === metric));
      const el = t.querySelector('.so-d');
      el.textContent = d ? arrow(d) : '—';
      el.className = `so-d ${cls(d)}`;
    });
    card.querySelector('[data-so-from]').textContent = data.length > 1 ? shortDay(first.day) : '';
    card.querySelector('[data-so-to]').textContent = data.length > 1 ? shortDay(last.day) : '';
    // Chart
    if (data.length < 2) { svg.innerHTML = ''; points = []; return; }
    const W = chart.clientWidth;
    const H = chart.clientHeight;
    const pad = 6;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const vals = data.map((r) => Number(r[metric]) || 0);
    let mn = Math.min(...vals);
    let mx = Math.max(...vals);
    if (mx === mn) { mx += 1; mn -= 1; }
    points = vals.map((v, i) => [pad + (i * (W - pad * 2)) / (vals.length - 1), pad + 10 + (1 - (v - mn) / (mx - mn)) * (H - pad * 2 - 16)]);
    let d = `M${points[0][0]},${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      const cx = (points[i - 1][0] + points[i][0]) / 2;
      d += ` C${cx},${points[i - 1][1]} ${cx},${points[i][1]} ${points[i][0]},${points[i][1]}`;
    }
    svg.innerHTML = `<defs><linearGradient id="so-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${d} L${points[points.length - 1][0]},${H} L${points[0][0]},${H} Z" fill="url(#so-fill)"/>
      <path class="so-line" d="${d}" stroke="${color}"/>
      <line class="so-cross" y1="0" y2="${H}" style="display:none"/>
      <circle r="5" fill="${color}" stroke="var(--card)" stroke-width="2" style="display:none"/>`;
  }

  function show(x) {
    if (!points.length) return;
    const W = chart.clientWidth;
    const step = (W - 12) / (points.length - 1);
    const i = Math.max(0, Math.min(points.length - 1, Math.round((x - 6) / step)));
    const [px, py] = points[i];
    const row = data[i];
    const prevRow = i ? data[i - 1] : days[days.length - data.length - 1];
    const line = svg.querySelector('.so-cross');
    const dot = svg.querySelector('circle');
    line.setAttribute('x1', px); line.setAttribute('x2', px); line.style.display = '';
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.style.display = '';
    if (metric === 'members') {
      const net = row.joins - row.leaves;
      tip.innerHTML = `<b>${longDay(row.day)}</b><div class="v">${nf(row.members)} members</div>
        <div class="r"><span>Joined</span><span class="up">+${nf(row.joins)}</span></div>
        <div class="r"><span>Left</span><span class="down">−${nf(row.leaves)}</span></div>
        <div class="r"><span>Net</span><span class="${cls(net)}">${sign(net)}</span></div>`;
    } else {
      const ch = prevRow ? row[metric] - prevRow[metric] : 0;
      tip.innerHTML = `<b>${longDay(row.day)}</b><div class="v">${nf(row[metric])} ${LABEL[metric].toLowerCase()}</div>
        <div class="r"><span>vs day before</span><span class="${cls(ch)}">${prevRow ? sign(ch) : '—'}</span></div>`;
    }
    tip.classList.add('show');
    const tw = tip.offsetWidth;
    tip.style.left = `${px + 14 + tw <= W ? px + 14 : Math.max(0, px - 14 - tw)}px`;
  }
  function hide() {
    tip.classList.remove('show');
    svg.querySelectorAll('.so-cross, circle').forEach((el) => { el.style.display = 'none'; });
  }

  chart.addEventListener('mousemove', (e) => show(e.clientX - chart.getBoundingClientRect().left));
  chart.addEventListener('mouseleave', hide);
  chart.addEventListener('touchstart', (e) => show(e.touches[0].clientX - chart.getBoundingClientRect().left), { passive: true });
  chart.addEventListener('touchmove', (e) => show(e.touches[0].clientX - chart.getBoundingClientRect().left), { passive: true });
  chart.addEventListener('touchend', () => setTimeout(hide, 1500));
  tiles.forEach((t) => t.addEventListener('click', () => { metric = t.dataset.metric; hide(); draw(); }));
  card.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    range = Number(b.dataset.range);
    card.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b));
    hide(); draw();
  }));
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 100); });
  draw();
});
