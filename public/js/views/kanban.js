// Канбан: колонки по статусам, перетаскивание карточек. Для клавиатуры и телефона —
// список «Переместить» на каждой карточке. Сервер проверяет допустимость перехода.
import { h, mount, toast, badge, slaChip, options, field } from '../dom.js';
import { getWithMeta, post, qs } from '../api.js';

const COLUMNS = ['new', 'in_review', 'need_info', 'in_progress', 'implemented', 'rejected'];
const FINAL = ['implemented', 'rejected', 'closed'];
const BOARD_LIMIT = 100;

// Для уточнения нужен вопрос автору, для итогового статуса — результат: спрашиваем в диалоге.
function askDetails(ticket, target, meta) {
  return new Promise((resolve) => {
    const isFinal = FINAL.includes(target.key);
    const fieldName = isFinal ? 'resolution' : 'comment';
    const input = h('textarea', { rows: 4, required: true });
    const templates = meta.templates.filter((t) => t.field === fieldName);
    const picker = h('select', { 'aria-label': 'Шаблон ответа', onchange: () => {
      const found = templates.find((t) => String(t.id) === picker.value);
      if (found) input.value = found.text;
    } }, options(templates.map((t) => ({ key: t.id, label: t.title })), { empty: 'Шаблон ответа…' }));
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

export async function renderKanban(el, { me, meta, rerender }) {
  const isOversight = me.role === 'manager' || me.role === 'admin';
  const scope = isOversight ? 'all' : 'assigned';
  const { data: tickets, meta: pageMeta } = await getWithMeta(`/tickets${qs({ scope, notClosed: '1', limit: BOARD_LIMIT })}`);
  const labels = Object.fromEntries(meta.statuses.map((s) => [s.key, s.label]));
  const byId = new Map(tickets.map((t) => [String(t.id), t]));
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

  const card = (t) => {
    const moves = allowed(t).filter((s) => s.key !== 'closed' || FINAL.includes(t.status));
    return h('article', {
      class: `kb-card ${t.sla.overdue ? 'overdue' : ''}`, draggable: 'true',
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; },
    },
    h('a', { href: `#/t/${t.id}`, class: 'kb-title' }, h('span', { class: 't-code' }, t.code), ' ', t.title),
    h('div', { class: 'row' }, badge('priority', t.priority, t.priorityLabel), slaChip(t)),
    h('div', { class: 't-sub' }, `${t.category.name}${isOversight ? ` · ${t.assignee?.name ?? 'без ответственного'}` : ''}`),
    moves.length > 0 && h('select', {
      class: 'kb-move', 'aria-label': `Переместить ${t.code}`,
      onchange: (e) => { const value = e.target.value; e.target.value = ''; if (value) move(t, value); },
    }, options(moves, { empty: 'Переместить…' })));
  };

  const column = (status) => {
    const items = tickets.filter((t) => t.status === status);
    const col = h('section', {
      class: 'kb-col', 'data-status': status,
      ondragover: (e) => { e.preventDefault(); col.classList.add('kb-over'); },
      ondragleave: () => col.classList.remove('kb-over'),
      ondrop: (e) => {
        e.preventDefault();
        col.classList.remove('kb-over');
        const ticket = byId.get(e.dataTransfer.getData('text/plain'));
        if (ticket && ticket.status !== status) move(ticket, status);
      },
    },
    h('header', { class: 'kb-head' }, h('span', { class: `badge status-${status}` }, labels[status]), h('span', { class: 'muted' }, String(items.length))),
    items.length === 0 ? h('p', { class: 'kb-empty' }, 'Пусто') : items.map(card));
    return col;
  };

  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Канбан'),
        h('p', null, isOversight
          ? 'Все обращения по статусам. Перетащите карточку в другую колонку или выберите «Переместить».'
          : 'Ваша очередь по статусам. Перетащите карточку в другую колонку или выберите «Переместить».'))),
    pageMeta.total > tickets.length && h('p', { class: 'count' }, `Показаны последние ${tickets.length} из ${pageMeta.total}`),
    h('div', { class: 'kanban' }, COLUMNS.map(column)));
}
