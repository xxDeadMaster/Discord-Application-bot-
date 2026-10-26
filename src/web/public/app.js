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
    const extra = el?.closest('[data-tab-extra]')?.dataset.tabExtra;
    start = tabs.find((t) => panelOf(t) === panel || (extra && t.dataset.tab === extra));
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

/* ---------- Copy buttons ---------- */
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const input = document.getElementById(btn.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    const old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = old; }, 1500);
  });
});

/* ---------- Extra blocks that belong to a tab but sit outside its form ---------- */
(() => {
  const extras = document.querySelectorAll('[data-tab-extra]');
  if (!extras.length) return;
  const sync = () => {
    const active = document.querySelector('[data-tabs] [aria-selected="true"]')?.dataset.tab;
    extras.forEach((el) => { el.hidden = Boolean(active) && el.dataset.tabExtra !== active; });
  };
  document.querySelectorAll('[data-tabs] [data-tab]').forEach((t) => { t.addEventListener('click', sync); t.addEventListener('keyup', sync); });
  sync();
})();
