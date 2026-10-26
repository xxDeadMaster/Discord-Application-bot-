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
