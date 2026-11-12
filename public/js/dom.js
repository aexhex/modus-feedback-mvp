// DOM-хелперы. Весь пользовательский текст вставляется через textContent — защита от XSS.
import { locale } from './i18n.js';

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

const dateFmt = new Intl.DateTimeFormat(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// В Chromium нет казахских названий месяцев (выходит «M11 07») — для казахского короткая дата числом.
const shortFmt = new Intl.DateTimeFormat(locale(), locale() === 'kk-KZ' ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: 'short' });

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

const SVG_NS = 'http://www.w3.org/2000/svg';

// Аналог h() для SVG: элементы создаются в пространстве имён SVG.
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, val] of Object.entries(attrs ?? {})) {
    if (val === null || val === undefined || val === false) continue;
    if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
    else el.setAttribute(key, String(val));
  }
  append(el, children);
  return el;
}

const ICON_PATHS = {
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  clip: ['M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'],
};

export const icon = (name, size = 18) => svg('svg', {
  viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
  'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon',
}, ICON_PATHS[name].map((d) => svg('path', { d })));

const FILE_TYPES = '.pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx,.csv';

// Кнопка выбора файла на русском вместо системной: сам <input> скрыт, но доступен с клавиатуры.
export function filePicker({ multiple = false, onchange } = {}) {
  const names = h('span', { class: 'file-names muted' }, 'Файл не выбран');
  const input = h('input', { type: 'file', accept: FILE_TYPES, multiple, onchange: () => {
    const list = [...input.files].map((f) => f.name);
    names.textContent = list.length ? list.join(', ') : 'Файл не выбран';
    if (onchange) onchange(input);
  } });
  const el = h('label', { class: 'file-pick' }, input,
    h('span', { class: 'btn btn-sm' }, icon('clip', 16), multiple ? 'Выбрать файлы' : 'Прикрепить файл'), names);
  return { el, input };
}

const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.82;

// Фото с телефона уменьшается до 1600 px по длинной стороне и сохраняется в JPEG:
// так оно укладывается в лимит 5 МБ и быстро уходит даже по мобильной сети.
export async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
  return { dataUrl, dataBase64: dataUrl.split(',')[1] };
}

// Переключатель светлой и тёмной темы: в верхней панели, на экране входа и на форме для клиентов.
export function themeToggle() {
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  const btn = h('button', {
    class: 'btn btn-ghost theme-toggle', 'aria-label': 'Переключить светлую и тёмную тему', title: 'Светлая / тёмная тема',
    onclick: () => {
      const next = isDark() ? 'light' : 'dark';
      // Смена темы мгновенная: без этого кнопки и карточки «доезжали» бы до новых цветов анимацией.
      const rootEl = document.documentElement;
      rootEl.classList.add('theme-switching');
      rootEl.dataset.theme = next;
      void rootEl.offsetWidth;
      requestAnimationFrame(() => rootEl.classList.remove('theme-switching'));
      try {
        localStorage.setItem('theme', next);
      } catch {
        // Хранилище недоступно: тема сменится до перезагрузки страницы.
      }
      btn.replaceChildren(icon(isDark() ? 'sun' : 'moon', 20));
    },
  }, icon(isDark() ? 'sun' : 'moon', 20));
  return btn;
}
