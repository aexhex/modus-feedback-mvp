// Настройки, вынесенные из кода в интерфейс: шаблоны ответов, праздники, пользователи, журнал действий.
import { h, toast, options, field } from '../dom.js';
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

const COUNTRIES = [{ key: 'ru', label: 'Россия' }, { key: 'kz', label: 'Казахстан' }];
const lines = (el) => el.value.split('\n').map((s) => s.trim()).filter(Boolean);

// Производственный календарь: загрузка на год из открытого источника или правка вручную.
export function holidaysCard(calendar, reload) {
  const year = new Date().getFullYear();
  const yearIn = h('select', { 'aria-label': 'Год календаря' }, options([year, year + 1].map((y) => ({ key: y, label: String(y) }))));
  const countryIn = h('select', { 'aria-label': 'Страна календаря' }, options(COUNTRIES));
  countryIn.value = calendar.source.country;
  const loadBtn = h('button', { class: 'btn', type: 'button' }, 'Загрузить производственный календарь');
  loadBtn.onclick = guarded(async () => {
    loadBtn.disabled = true;
    try {
      const r = await post('/admin/calendar/import', { year: Number(yearIn.value), country: countryIn.value });
      toast(`${r.loaded.year}: ${t('праздников')} ${r.loaded.holidays}, ${t('рабочих выходных')} ${r.loaded.workdays}`, 'success');
    } finally {
      loadBtn.disabled = false;
    }
  }, reload);
  const holidaysIn = h('textarea', { rows: 7, class: 'mono', 'aria-label': 'Праздничные дни' }, calendar.holidays.join('\n'));
  const workdaysIn = h('textarea', { rows: 3, class: 'mono', 'aria-label': 'Рабочие выходные' }, calendar.workdays.join('\n'));
  const source = calendar.source.mode === 'demo' ? t('демо-портал (в демо доступен календарь РФ на 2026–2027)') : calendar.source.host;
  return h('section', { class: 'card' },
    h('h3', null, 'Производственный календарь'),
    h('p', { class: 't-sub' }, 'Сроки SLA считаются в рабочих днях. Календарь на год загружается из открытого источника (праздники и переносы) и заменяет даты этого года; другие годы не меняются.'),
    h('div', { class: 'row calendar-load' }, yearIn, countryIn, loadBtn),
    h('p', { class: 't-sub' }, `${t('Источник')}: `, h('span', { 'data-no-i18n': '' }, source)),
    h('form', { class: 'stack', onsubmit: guarded(() => patch('/admin/holidays', { dates: lines(holidaysIn), workdays: lines(workdaysIn) }), reload, 'Календарь сохранён') },
      field('Праздничные дни', holidaysIn, 'Нерабочие дни, выпадающие на будни. По одной дате в строке, ГГГГ-ММ-ДД.'),
      field('Рабочие выходные', workdaysIn, 'Субботы и воскресенья, которые по переносу рабочие.'),
      h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить календарь'))));
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
    // Рабочие контакты: обычно приходят из Битрикс24 вместе с оргструктурой, здесь — правка вручную.
    const contactIn = (key, type, label, max) => h('input', { type, value: u[key] ?? '', maxlength: max, placeholder: label, 'aria-label': `${t(label)}: ${u.name}` });
    const positionIn = contactIn('position', 'text', 'Должность', 80);
    const emailIn = contactIn('email', 'email', 'Почта', 120);
    const phoneIn = contactIn('phone', 'tel', 'Телефон', 30);
    const contacts = h('details', { class: 'contact-edit' },
      h('summary', null, u.email || u.phone || u.position ? 'Контакты' : 'Добавить контакты'),
      h('form', { class: 'stack', onsubmit: guarded(() => patch(`/admin/users/${u.id}/contacts`, { position: positionIn.value, email: emailIn.value, phone: phoneIn.value }), reload, `${u.name}: ${t('контакты сохранены')}`) },
        positionIn, emailIn, phoneIn, h('div', null, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Сохранить'))));
    return h('tr', { class: u.isActive ? '' : 'user-off' },
      h('td', null, h('b', null, u.name), isSelf && h('span', { class: 'chip' }, 'это вы'),
        (u.email || u.phone) && h('div', { class: 't-sub', 'data-no-i18n': '' }, [u.email, u.phone].filter(Boolean).join(' · ')), contacts),
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

// Импорт из CSV (например, выгрузка оргструктуры из 1С): строки «имя;роль;подразделение[;почта;телефон]».
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
    h('p', { class: 't-sub' }, 'Строка файла: имя;роль;подразделение;почта;телефон (почта и телефон — необязательно). Роль — сотрудник, ответственный, руководитель или администратор. Первая строка может быть заголовком; уже существующие имена и строки с неверной почтой или телефоном пропускаются.'),
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

