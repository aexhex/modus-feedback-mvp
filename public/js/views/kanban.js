// Канбан: четыре рабочие колонки во всю ширину, завершённые обращения — в свёрнутом блоке под доской.
// Карточки компактные; переместить — перетаскиванием или кнопкой «⋯» (клавиатура, телефон).
// Поиск и отборы работают без перезагрузки. Сервер проверяет допустимость перехода.
import { h, mount, toast, badge, slaChip, options, field } from '../dom.js';
import { getWithMeta, post, qs } from '../api.js';
import { t } from '../i18n.js';

const ACTIVE = ['new', 'in_review', 'need_info', 'in_progress'];
const DONE = ['implemented', 'rejected'];
const FINAL = ['implemented', 'rejected', 'closed'];
const BOARD_LIMIT = 100;
const NO_ASSIGNEE = 'none';

// Отборы переживают перерисовку после перемещения карточки.
const filters = { q: '', overdue: false, assignee: '', doneOpen: false };

// Для уточнения нужен вопрос автору, для итогового статуса — результат: спрашиваем в диалоге.
function askDetails(ticket, target, meta) {
  return new Promise((resolve) => {
    const isFinal = FINAL.includes(target.key);
    const fieldName = isFinal ? 'resolution' : 'comment';
    const input = h('textarea', { rows: 4, required: true });
    const templates = meta.templates.filter((x) => x.field === fieldName);
    const picker = h('select', { 'aria-label': 'Шаблон ответа', onchange: () => {
      const found = templates.find((x) => String(x.id) === picker.value);
      if (found) input.value = found.text;
    } }, options(templates.map((x) => ({ key: x.id, label: x.title })), { empty: 'Шаблон ответа…' }));
    const dialog = h('dialog', { class: 'dialog' },
      h('form', { method: 'dialog', class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        dialog.close();
        resolve({ [fieldName]: input.value });
      } },
      h('h2', null, `${ticket.code} → ${target.label}`),
      field(isFinal ? 'Результат рассмотрения (увидит автор)' : 'Вопрос автору', input),
      picker,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Переместить'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { dialog.close(); resolve(null); } }, 'Отмена'))));
    dialog.addEventListener('cancel', () => resolve(null));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// Сначала просроченные, затем по ближайшему сроку.
const deadline = (x) => (x.firstResponseAt ? x.dueAt : x.firstResponseDue) ?? '9999';
const byUrgency = (a, b) => Number(b.sla.overdue) - Number(a.sla.overdue) || deadline(a).localeCompare(deadline(b));

function matches(ticket) {
  const q = filters.q.trim().toLowerCase();
  if (q && !`${ticket.code} ${ticket.title}`.toLowerCase().includes(q)) return false;
  if (filters.overdue && !ticket.sla.overdue) return false;
  if (filters.assignee === NO_ASSIGNEE) return !ticket.assignee;
  if (filters.assignee) return String(ticket.assignee?.id) === filters.assignee;
  return true;
}

// Открыто не больше одного меню «⋯»; щелчок мимо закрывает его.
document.addEventListener('click', (e) => {
  for (const menu of document.querySelectorAll('.kb-menu[open]')) if (!menu.contains(e.target)) menu.open = false;
});

export async function renderKanban(el, { me, meta, rerender }) {
  const isOversight = me.role === 'manager' || me.role === 'admin';
  const scope = isOversight ? 'all' : 'assigned';
  const { data: tickets, meta: pageMeta } = await getWithMeta(`/tickets${qs({ scope, notClosed: '1', limit: BOARD_LIMIT })}`);
  const labels = Object.fromEntries(meta.statuses.map((s) => [s.key, s.label]));
  const byId = new Map(tickets.map((x) => [String(x.id), x]));
  const allowed = (ticket) => meta.transitions[ticket.status].map((key) => ({ key, label: labels[key] }));

  const move = async (ticket, targetKey) => {
    const target = allowed(ticket).find((s) => s.key === targetKey);
    if (!target) {
      toast(`Переход «${ticket.statusLabel}» → «${labels[targetKey]}» недопустим`, 'error');
      return;
    }
    const needsDetails = target.key === 'need_info' || (FINAL.includes(target.key) && !ticket.resolution);
    const details = needsDetails ? await askDetails(ticket, target, meta) : {};
    if (details === null) return;
    try {
      await post(`/tickets/${ticket.id}/status`, { status: target.key, ...details });
      toast(`${ticket.code}: ${target.label}`, 'success');
      rerender();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const moveMenu = (ticket) => {
    const moves = allowed(ticket).filter((s) => s.key !== 'closed' || FINAL.includes(ticket.status));
    if (moves.length === 0) return null;
    const menu = h('details', { class: 'kb-menu' },
      h('summary', { 'aria-label': `${t('Переместить')} ${ticket.code}`, title: t('Переместить') }, '⋯'),
      h('div', { class: 'kb-menu-list' },
        h('span', { class: 'kb-menu-title' }, 'Переместить в'),
        moves.map((s) => h('button', { type: 'button', onclick: () => { menu.open = false; move(ticket, s.key); } }, s.label))));
    return menu;
  };

  const card = (ticket) => h('article', {
    class: `kb-card ${ticket.sla.overdue ? 'overdue' : ''}`, draggable: 'true', 'data-code': ticket.code,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(ticket.id)); e.dataTransfer.effectAllowed = 'move'; },
  },
  h('div', { class: 'kb-card-top' }, h('span', { class: 't-code' }, ticket.code), slaChip(ticket), moveMenu(ticket)),
  h('a', { href: `#/t/${ticket.id}`, class: 'kb-title', title: ticket.title }, ticket.title),
  h('div', { class: 'kb-meta' },
    badge('priority', ticket.priority, ticket.priorityLabel),
    h('span', { class: 'kb-who' }, isOversight ? (ticket.assignee?.name ?? t('без ответственного')) : ticket.category.name)));

  const column = (status, items) => {
    const overdue = items.filter((x) => x.sla.overdue).length;
    const col = h('section', {
      class: 'kb-col', 'data-status': status, 'aria-label': labels[status],
      ondragover: (e) => { e.preventDefault(); col.classList.add('kb-over'); },
      ondragleave: () => col.classList.remove('kb-over'),
      ondrop: (e) => {
        e.preventDefault();
        col.classList.remove('kb-over');
        const ticket = byId.get(e.dataTransfer.getData('text/plain'));
        if (ticket && ticket.status !== status) move(ticket, status);
      },
    },
    h('header', { class: 'kb-head' },
      h('span', { class: `badge status-${status}` }, labels[status]),
      h('span', { class: 'kb-count' }, String(items.length)),
      overdue > 0 && h('span', { class: 'kb-overdue' }, `${t('просрочено')}: ${overdue}`)),
    h('div', { class: 'kb-cards' }, items.length === 0 ? h('p', { class: 'kb-empty' }, 'Пусто') : items.map(card)));
    return col;
  };

  const board = h('div');
  const draw = () => {
    const visible = tickets.filter(matches).sort(byUrgency);
    const of = (status) => visible.filter((x) => x.status === status);
    const done = h('details', { class: 'kb-done', open: filters.doneOpen, ontoggle: (e) => { filters.doneOpen = e.target.open; } },
      h('summary', null, `${t('Завершено')}: ${t('реализовано')} ${of('implemented').length} · ${t('отклонено')} ${of('rejected').length}`),
      h('div', { class: 'kanban kanban-done' }, DONE.map((s) => column(s, of(s)))));
    mount(board,
      h('div', { class: 'kanban' }, ACTIVE.map((s) => column(s, of(s)))),
      done);
  };

  const assignees = [...new Map(tickets.filter((x) => x.assignee).map((x) => [String(x.assignee.id), x.assignee.name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  const search = h('input', { type: 'search', value: filters.q, placeholder: 'Поиск по номеру или теме', 'aria-label': 'Поиск по канбану',
    oninput: (e) => { filters.q = e.target.value; draw(); } });
  const overdueOnly = h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: filters.overdue, onchange: (e) => { filters.overdue = e.target.checked; draw(); } }),
    h('span', null, 'Только просроченные'));
  const assigneeIn = isOversight && h('select', { 'aria-label': 'Ответственный', onchange: (e) => { filters.assignee = e.target.value; draw(); } },
    options([{ key: NO_ASSIGNEE, label: 'Без ответственного' }, ...assignees.map(([key, label]) => ({ key, label }))], { empty: 'Все ответственные' }));
  if (assigneeIn) assigneeIn.value = filters.assignee;

  draw();
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Канбан'),
        h('p', null, isOversight
          ? 'Все обращения в работе. Перетащите карточку в другую колонку или нажмите «⋯». Сверху — просроченные.'
          : 'Ваша очередь. Перетащите карточку в другую колонку или нажмите «⋯». Сверху — просроченные.'))),
    h('div', { class: 'kb-toolbar' }, search, overdueOnly, assigneeIn),
    pageMeta.total > tickets.length && h('p', { class: 'count' }, `Показаны последние ${tickets.length} из ${pageMeta.total}`),
    board);
}
