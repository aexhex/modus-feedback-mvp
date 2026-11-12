// Настройки, вынесенные из кода в интерфейс: шаблоны ответов, праздники, пользователи, журнал действий.
import { h, toast, options } from '../dom.js';
import { locale, t } from '../i18n.js';
import { post, patch, del } from '../api.js';
import { filePicker } from '../dom.js';

const ROLE_OPTIONS = [
  { key: 'employee', label: 'Сотрудник' }, { key: 'handler', label: 'Ответственный' },
  { key: 'manager', label: 'Руководитель' }, { key: 'admin', label: 'Администратор' },
];
const FIELD_OPTIONS = [{ key: 'comment', label: 'В комментарий' }, { key: 'resolution', label: 'В результат' }];

const guarded = (action, reload, message) => async (e) => {
  e?.preventDefault?.();
  try {
    await action();
    if (message) toast(message, 'success');
    reload();
  } catch (err) { toast(err.message, 'error'); }
};

export function templatesCard(templates, reload) {
  const row = (t) => {
    const title = h('input', { type: 'text', value: t.title, maxlength: 60, 'aria-label': 'Название шаблона' });
    const target = h('select', { value: t.field, 'aria-label': 'Куда подставлять' }, options(FIELD_OPTIONS));
    const text = h('textarea', { rows: 2, maxlength: 3000, 'aria-label': 'Текст шаблона' }, t.text);
    return h('li', { class: 'template-row' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, title), target),
      text,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', onclick: guarded(() => patch(`/admin/templates/${t.id}`, { title: title.value, field: target.value, text: text.value }), reload, 'Шаблон сохранён') }, 'Сохранить'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: guarded(() => del(`/admin/templates/${t.id}`), reload, 'Шаблон удалён') }, 'Удалить')));
  };
  const title = h('input', { type: 'text', maxlength: 60, placeholder: 'Название' });
  const target = h('select', { 'aria-label': 'Куда подставлять' }, options(FIELD_OPTIONS));
  const text = h('textarea', { rows: 2, maxlength: 3000, placeholder: 'Текст ответа' });
  return h('section', { class: 'card' },
    h('h3', null, 'Шаблоны ответов'),
    h('p', { class: 't-sub' }, 'Ответственный вставляет шаблон в комментарий или в результат рассмотрения и может дописать.'),
    h('ul', { class: 'list-plain' }, templates.map(row)),
    h('form', { class: 'stack template-new', onsubmit: guarded(() => post('/admin/templates', { title: title.value, field: target.value, text: text.value }), reload, 'Шаблон добавлен') },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, title), target), text,
      h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Добавить шаблон'))));
}

export function holidaysCard(dates, reload) {
  const input = h('textarea', { rows: 8, class: 'mono', 'aria-label': 'Праздничные дни' }, dates.join('\n'));
  return h('section', { class: 'card' },
    h('h3', null, 'Праздничные дни'),
    h('p', { class: 't-sub' }, 'Нерабочие дни, выпадающие на будни. По одной дате в строке, формат ГГГГ-ММ-ДД. Действует для сроков, рассчитанных после сохранения.'),
    h('form', { class: 'stack', onsubmit: guarded(() => patch('/admin/holidays', { dates: input.value.split('\n').map((s) => s.trim()).filter(Boolean) }), reload, 'Список праздников сохранён') },
      input, h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить праздники'))));
}

export function usersAdminCard(users, me, reload) {
  const save = (u, body, message) => guarded(() => patch(`/admin/users/${u.id}`, body), reload, message);
  const row = (u) => {
    const isSelf = u.id === me.id;
    const role = h('select', { value: u.role, disabled: isSelf, 'aria-label': `Роль: ${u.name}`,
      onchange: (e) => save(u, { role: e.target.value }, `${u.name}: роль изменена`)() }, options(ROLE_OPTIONS));
    const department = h('input', { type: 'text', value: u.department, maxlength: 80, 'aria-label': `Подразделение: ${u.name}`,
      onchange: (e) => save(u, { department: e.target.value }, `${u.name}: подразделение изменено`)() });
    // Связь с Битрикс24 открывает вход через портал; ошибочную связь администратор снимает здесь.
    const unlink = () => {
      if (!window.confirm(`${u.name}: ${t('отвязать от Битрикс24? Этот человек больше не сможет входить через портал под этой учётной записью, его открытые сессии закроются.')}`)) return;
      guarded(() => post('/admin/integrations/b24/unlink', { userId: u.id }), reload, `${u.name}: ${t('отвязан от Битрикс24')}`)();
    };
    const b24 = u.b24Id
      ? h('div', { class: 'b24-link' }, h('span', { class: 't-sub' }, `ID ${u.b24Id}`),
        !isSelf && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `${t('Отвязать от Битрикс24')}: ${u.name}`, onclick: unlink }, 'Отвязать'))
      : h('span', { class: 't-sub' }, '—');
    return h('tr', { class: u.isActive ? '' : 'user-off' },
      h('td', null, h('b', null, u.name), isSelf && h('span', { class: 'chip' }, 'это вы')),
      h('td', null, role),
      h('td', null, department),
      h('td', null, h('input', { type: 'checkbox', checked: u.isAvailable, disabled: isSelf || !u.isActive, 'aria-label': `На месте: ${u.name}`,
        onchange: (e) => save(u, { isAvailable: e.target.checked }, `${u.name}: ${e.target.checked ? 'на месте' : 'отсутствует'}`)() })),
      h('td', null, h('input', { type: 'checkbox', checked: u.isActive, disabled: isSelf, 'aria-label': `Доступ: ${u.name}`,
        onchange: (e) => save(u, { isActive: e.target.checked }, `${u.name}: ${e.target.checked ? 'доступ включён' : 'доступ отключён'}`)() })),
      h('td', null, b24));
  };
  const name = h('input', { type: 'text', maxlength: 80, required: true, placeholder: 'Имя или должность' });
  const role = h('select', { 'aria-label': 'Роль' }, options(ROLE_OPTIONS));
  const department = h('input', { type: 'text', maxlength: 80, required: true, placeholder: 'Подразделение' });
  return h('section', { class: 'card' },
    h('h3', null, 'Пользователи и роли'),
    h('p', { class: 't-sub' }, '«На месте» — участвует в маршрутизации (снимите на время отпуска). «Доступ» — может ли входить в систему.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'table users-table' },
      h('thead', null, h('tr', null, ['Пользователь', 'Роль', 'Подразделение', 'На месте', 'Доступ', 'Битрикс24'].map((c) => h('th', null, c)))),
      h('tbody', null, users.map(row)))),
    h('form', { class: 'row user-new', onsubmit: guarded(() => post('/admin/users', { name: name.value, role: role.value, department: department.value }), reload, 'Пользователь добавлен') },
      h('div', { class: 'grow' }, name), role, h('div', { class: 'grow' }, department),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Добавить пользователя')),
    importBlock(reload));
}

// Импорт из CSV (например, выгрузка оргструктуры из 1С): строки «имя;роль;подразделение».
function importBlock(reload) {
  const report = h('div', { class: 'import-report' });
  const picker = filePicker({ onchange: async (input) => {
    const file = input.files[0];
    if (!file) return;
    try {
      const result = await post('/admin/users/import', { csv: await file.text() });
      toast(`Добавлено: ${result.created.length}, пропущено: ${result.skipped.length}`, result.skipped.length ? 'info' : 'success');
      if (result.skipped.length === 0) { reload(); return; }
      report.replaceChildren(
        h('b', null, 'Не добавлены:'),
        h('ul', { class: 'list-plain' }, result.skipped.map((s) => h('li', null, `Строка ${s.line}: ${s.name || '—'} — ${s.reason}`))),
        h('button', { class: 'btn btn-sm', onclick: reload }, 'Обновить список'));
    } catch (err) { toast(err.message, 'error'); }
    input.value = '';
  } });
  picker.input.accept = '.csv,.txt';
  return h('div', { class: 'stack user-import' },
    h('h3', null, 'Импорт из CSV'),
    h('p', { class: 't-sub' }, 'Строка файла: имя;роль;подразделение. Роль — сотрудник, ответственный, руководитель или администратор. Первая строка может быть заголовком; уже существующие имена пропускаются.'),
    picker.el, report);
}

export function auditCard(entries) {
  return h('section', { class: 'card' },
    h('h3', null, 'Журнал действий администратора'),
    h('p', { class: 't-sub' }, 'Последние 100 изменений настроек: кто, что и когда.'),
    entries.length === 0 ? h('p', { class: 'muted' }, 'Изменений пока не было')
      : h('ul', { class: 'list-plain audit-list' }, entries.map((a) => h('li', null,
        h('b', null, a.action), a.details && ` — ${a.details}`,
        h('div', { class: 't-sub' }, `${a.actorName ?? 'Система'} · ${new Date(a.createdAt).toLocaleString(locale())}`)))));
}

