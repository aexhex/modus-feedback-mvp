// DOM-хелперы. Весь пользовательский текст вставляется через textContent — защита от XSS.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [key, val] of Object.entries(props ?? {})) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'class') el.className = val;
    else if (key === 'style') Object.assign(el.style, val);
    else if (key === 'value') value = val;
    else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(val);
    else el.setAttribute(key, val === true ? '' : String(val));
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' });

export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const fmtShort = (iso) => (iso ? shortFmt.format(new Date(iso)) : '—');

export function fmtRelative(iso) {
  const diffH = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (diffH < 1) return 'только что';
  if (diffH < 24) return `${Math.floor(diffH)} ч назад`;
  const days = Math.floor(diffH / 24);
  return `${days} дн. назад`;
}

export const badge = (kind, value, label) => h('span', { class: `badge ${kind}-${value}` }, label);

export function slaChip(ticket) {
  if (ticket.sla?.overdue) {
    return h('span', { class: 'chip chip-danger', title: 'Нарушен срок SLA' },
      ticket.sla.kind === 'first_response' ? 'Нет ответа в срок' : 'Срок решения истёк');
  }
  if (['implemented', 'rejected', 'closed'].includes(ticket.status)) {
    return h('span', { class: 'chip chip-muted' }, `Решено ${fmtShort(ticket.resolvedAt)}`);
  }
  const due = ticket.firstResponseAt ? ticket.dueAt : ticket.firstResponseDue;
  return h('span', { class: 'chip' }, `${ticket.firstResponseAt ? 'Решить до' : 'Ответ до'} ${fmtShort(due)}`);
}

export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('toast-hide'), 3800);
  setTimeout(() => el.remove(), 4300);
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export const field = (label, control, hint) =>
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'field-hint' }, hint));

export const options = (items, { valueKey = 'key', labelKey = 'label', empty } = {}) => [
  empty !== undefined ? h('option', { value: '' }, empty) : null,
  ...items.map((item) => h('option', { value: String(item[valueKey]) }, item[labelKey])),
];
