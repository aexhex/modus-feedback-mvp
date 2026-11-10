import { h, mount, toast, options } from '../dom.js';
import { get, post, patch } from '../api.js';

const ROLE_LABELS = { employee: 'Сотрудник', handler: 'Ответственный', manager: 'Руководитель', admin: 'Администратор' };

function categoriesCard(categories, staff, reload) {
  const staffOptions = staff.map((u) => ({ key: u.id, label: u.name }));
  const save = (id, body) => patch(`/admin/categories/${id}`, body).then(() => toast('Правило сохранено', 'success')).catch((e) => { toast(e.message, 'error'); reload(); });
  const staffSelect = (c, key, empty) => h('select', {
    value: c[key] ? String(c[key]) : '',
    onchange: (e) => save(c.id, { [key]: e.target.value ? Number(e.target.value) : null }),
    'aria-label': empty,
  }, options(staffOptions, { empty }));

  const nameIn = h('input', { type: 'text', placeholder: 'Новая категория' });
  const add = async (e) => {
    e.preventDefault();
    try { await post('/admin/categories', { name: nameIn.value }); toast('Категория добавлена', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  return h('section', { class: 'card' },
    h('h3', null, 'Категории и маршрутизация'),
    h('p', { class: 't-sub' }, 'Обращение получает основной ответственный. Если он отсутствует — резервный, иначе руководитель-диспетчер.'),
    h('table', { class: 'table', style: { marginTop: '12px' } },
      h('thead', null, h('tr', null, ['Категория', 'Основной', 'Резервный', 'Обращений', 'Активна'].map((c) => h('th', null, c)))),
      h('tbody', null, categories.map((c) => h('tr', { style: { cursor: 'default' } },
        h('td', null, h('b', null, c.name)),
        h('td', null, staffSelect(c, 'assigneeId', '— не задан —')),
        h('td', null, staffSelect(c, 'fallbackId', '— не задан —')),
        h('td', null, String(c.ticketsCount)),
        h('td', null, h('input', { type: 'checkbox', checked: c.isActive, 'aria-label': 'Активна', onchange: (e) => save(c.id, { isActive: e.target.checked }) })))))),
    h('form', { class: 'row', style: { marginTop: '14px' }, onsubmit: add },
      h('div', { style: { flex: '1', minWidth: '220px' } }, nameIn), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Добавить категорию')));
}

function usersCard(users, me, reload) {
  const toggle = (u) => async (e) => {
    try {
      await patch(`/admin/users/${u.id}`, { isAvailable: e.target.checked });
      toast(`${u.name}: ${e.target.checked ? 'доступен' : 'отсутствует'}`, 'success');
    } catch (err) { toast(err.message, 'error'); reload(); }
  };
  return h('section', { class: 'card' },
    h('h3', null, 'Доступность ответственных'),
    h('p', { class: 't-sub' }, 'Отметьте отпуск или болезнь — новые обращения уйдут резервному ответственному.'),
    h('ul', { class: 'list-plain' }, users.filter((u) => u.role !== 'employee').map((u) =>
      h('li', { class: 'row', style: { justifyContent: 'space-between' } },
        h('div', null, h('b', null, u.name), h('div', { class: 't-sub' }, `${ROLE_LABELS[u.role]} · ${u.department}`)),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: u.isAvailable, disabled: u.id === me.id, onchange: toggle(u) }), 'на месте')))));
}

// Журнал того, что ушло бы в Битрикс24 (REST im.notify). Реальной отправки в MVP нет.
function outboxCard(items) {
  return h('section', { class: 'card' },
    h('h3', null, 'Уведомления в Битрикс24 — имитация'),
    h('p', { class: 't-sub' }, 'Интеграция не подключена: здесь показано, какие вызовы im.notify система отправила бы на портал. Последние 50 записей.'),
    items.length === 0 ? h('p', { class: 'muted' }, 'Пока пусто')
      : h('ul', { class: 'list-plain' }, items.map((o) => h('li', null,
        h('div', null, h('span', { class: 'chip' }, `${o.channel} · ${o.method}`), ' → ', h('b', null, o.recipient)),
        h('div', null, o.payload.MESSAGE),
        h('div', { class: 't-sub' }, new Date(o.createdAt).toLocaleString('ru-RU'))))));
}

export async function renderAdmin(el, { me, rerender, refreshMeta }) {
  const [categories, users, outbox] = await Promise.all([get('/admin/categories'), get('/admin/users'), get('/admin/outbox')]);
  const staff = users.filter((u) => u.role !== 'employee');
  const reload = async () => { await refreshMeta(); rerender(); };
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Настройки'), h('p', null, 'Справочник категорий, правила маршрутизации и замещение ответственных.'))),
    h('div', { class: 'grid-2' }, categoriesCard(categories, staff, reload), usersCard(users, me, reload)),
    outboxCard(outbox));
}
