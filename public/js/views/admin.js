import { h, mount, toast, options } from '../dom.js';
import { t } from '../i18n.js';
import { get, post, patch } from '../api.js';
import { templatesCard, holidaysCard, usersAdminCard, auditCard } from './admin-extra.js';
import { integrationsCard, outboxCard } from './admin-integrations.js';

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
    h('table', { class: 'table routing-table', style: { marginTop: '12px' } },
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

// Сроки SLA в рабочих днях; действуют для обращений, созданных после сохранения.
// Рабочие часы: рабочий день SLA — окно, например с 9 до 18; без них — сутки целиком.
function workHoursForm(workHours, reload) {
  const hoursOptions = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ key: from + i, label: `${String(from + i).padStart(2, '0')}:00` }));
  const enabled = h('input', { type: 'checkbox', checked: Boolean(workHours) });
  const startIn = h('select', { 'aria-label': 'Начало рабочего дня' }, options(hoursOptions(0, 23)));
  const endIn = h('select', { 'aria-label': 'Конец рабочего дня' }, options(hoursOptions(1, 24)));
  startIn.value = String(workHours?.start ?? 9);
  endIn.value = String(workHours?.end ?? 18);
  const sync = () => { startIn.disabled = !enabled.checked; endIn.disabled = !enabled.checked; };
  enabled.onchange = sync;
  sync();
  const save = async (e) => {
    e.preventDefault();
    try {
      await patch('/admin/work-hours', { enabled: enabled.checked, start: Number(startIn.value), end: Number(endIn.value) });
      toast('Рабочие часы сохранены — действуют для новых сроков', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('form', { class: 'stack work-hours', onsubmit: save },
    h('label', { class: 'check' }, enabled, h('span', null, 'Учитывать рабочие часы')),
    h('div', { class: 'row' }, h('span', null, 'с'), startIn, h('span', null, 'до'), endIn,
      h('button', { class: 'btn btn-sm', type: 'submit' }, 'Сохранить часы')),
    h('p', { class: 't-sub' }, 'Рабочий день срока — это окно рабочих часов: обращение, поданное вечером, начинает отсчёт утром следующего рабочего дня.'));
}

// Часовой пояс компании: рабочие дни и часы, недели в аналитике, границы суток в отчётах.
const TIMEZONES = Array.from({ length: 11 }, (_, i) => i + 2).map((n) => ({
  key: n, label: ({ 3: 'Москва (UTC+3)', 5: 'Казахстан (UTC+5)' })[n] ?? `UTC+${n}`,
}));

function timezoneForm(timezone, reload) {
  const select = h('select', { 'aria-label': 'Часовой пояс компании' }, options(TIMEZONES));
  select.value = String(timezone.offset);
  // Филиалы в другом поясе: срок обращения считается по поясу подразделения ответственного.
  const deptSelects = timezone.departmentList.map((name) => {
    const el = h('select', { 'aria-label': `${t('Часовой пояс')}: ${name}` }, options(TIMEZONES, { empty: 'Как у компании' }));
    el.value = timezone.departments[name] === undefined ? '' : String(timezone.departments[name]);
    return [name, el];
  });
  const custom = Object.keys(timezone.departments).length;
  const save = async (e) => {
    e.preventDefault();
    try {
      await patch('/admin/timezone', {
        offset: Number(select.value),
        departments: Object.fromEntries(deptSelects.map(([name, el]) => [name, el.value === '' ? null : Number(el.value)])),
      });
      toast('Часовой пояс сохранён — сроки новых обращений считаются по нему', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('form', { class: 'stack work-hours', onsubmit: save },
    h('div', { class: 'row' }, select, h('button', { class: 'btn btn-sm', type: 'submit' }, 'Сохранить пояс')),
    h('details', { class: 'dept-tz', open: custom > 0 },
      h('summary', null, `${t('Подразделения в другом поясе')}: ${custom}`),
      h('p', { class: 't-sub' }, 'Срок обращения считается по поясу подразделения ответственного — ему отвечать. Аналитика и отчёты — по поясу компании.'),
      h('div', { class: 'dept-tz-grid' }, deptSelects.map(([name, el]) => h('label', { class: 'dept-tz-row' }, h('span', null, name), el)))));
}

function slaCard(sla, reload, workHours, timezone) {
  const inputs = new Map();
  const num = (item, key) => {
    const input = h('input', { type: 'number', min: 1, max: 90, step: 1, value: String(item[key]), 'aria-label': `${item.label}: ${key === 'firstResponseDays' ? 'первый ответ' : 'решение'}` });
    inputs.set(`${item.key}.${key}`, input);
    return input;
  };
  const save = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(sla.map((item) => [item.key, {
      firstResponseDays: Number(inputs.get(`${item.key}.firstResponseDays`).value),
      resolveDays: Number(inputs.get(`${item.key}.resolveDays`).value),
    }]));
    try {
      await patch('/admin/sla', body);
      toast('Сроки сохранены — действуют для новых обращений', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('section', { class: 'card' },
    h('h3', null, 'Сроки рассмотрения (SLA)'),
    h('p', { class: 't-sub' }, 'В рабочих днях: выходные и праздники не считаются. У уже созданных обращений сроки не меняются.'),
    h('form', { onsubmit: save },
      h('table', { class: 'table sla-table' },
        h('thead', null, h('tr', null, ['Приоритет', 'Первый ответ, дней', 'Решение, дней'].map((c) => h('th', null, c)))),
        h('tbody', null, sla.map((item) => h('tr', null,
          h('td', null, h('b', null, item.label)),
          h('td', null, num(item, 'firstResponseDays')),
          h('td', null, num(item, 'resolveDays')))))),
      h('button', { class: 'btn btn-primary', type: 'submit', style: { marginTop: '12px' } }, 'Сохранить сроки')),
    h('h3', { style: { marginTop: '20px' } }, 'Часовой пояс'),
    h('p', { class: 't-sub' }, 'По нему считаются рабочие дни и часы, недели в аналитике и границы суток в отчётах.'),
    timezoneForm(timezone, reload),
    h('h3', { style: { marginTop: '20px' } }, 'Рабочие часы'),
    workHoursForm(workHours, reload));
}

// Целевые значения показателей (ТЗ 2.7): на странице «Показатели» рядом с фактом видна цель.
function targetsCard(targets, reload) {
  const inputs = new Map(targets.map((t) => [t.key, h('input', {
    type: 'number', min: 0, max: t.limit, step: t.unit === 'шт.' ? 1 : 0.1, value: String(t.value),
    'aria-label': `${t.label}: цель, ${t.unit}`,
  })]));
  const save = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(targets.map((t) => [t.key, inputs.get(t.key).value === '' ? '' : Number(inputs.get(t.key).value)]));
    try {
      await patch('/admin/targets', body);
      toast('Цели сохранены — сравнение видно в «Показателях»', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('section', { class: 'card' },
    h('h3', null, 'Цели показателей'),
    h('p', { class: 't-sub' }, 'ТЗ оставляет целевые значения на усмотрение компании. Задайте их здесь: в «Показателях» каждая плитка покажет, достигнута ли цель.'),
    h('form', { onsubmit: save },
      h('table', { class: 'table sla-table' },
        h('thead', null, h('tr', null, ['Показатель', 'Условие', 'Цель'].map((c) => h('th', null, c)))),
        h('tbody', null, targets.map((t) => h('tr', null,
          h('td', null, h('b', null, t.label)),
          h('td', null, t.dir === 'min' ? 'не меньше' : 'не больше'),
          h('td', null, h('span', { class: 'row target-input' }, inputs.get(t.key), h('span', { class: 't-sub' }, t.unit))))))),
      h('button', { class: 'btn btn-primary', type: 'submit', style: { marginTop: '12px' } }, 'Сохранить цели')));
}

// Сброс демо-данных: доступен только в демо-режиме, требует подтверждения и выводит всех из системы.
function demoCard() {
  const reset = async () => {
    // eslint-disable-next-line no-alert -- нативное подтверждение для разрушительного действия
    if (!window.confirm(t('Удалить все изменения и вернуть исходные демо-данные? Все пользователи будут выведены из системы.'))) return;
    try {
      await post('/admin/demo-reset');
      location.hash = '#/login';
      location.reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('section', { class: 'card demo-card' },
    h('h3', null, 'Демо-режим'),
    h('p', { class: 't-sub' }, 'Перед показом верните исходный датасет: удалятся созданные обращения, комментарии, файлы и изменения настроек. После сброса нужно войти заново.'),
    h('button', { class: 'btn btn-danger', onclick: reset }, 'Сбросить демо-данные'));
}

export async function renderAdmin(el, { me, meta, rerender, refreshMeta }) {
  const [categories, users, outbox, sla, templates, holidays, auditLog, targets, integrations, workHours, timezone] = await Promise.all([
    get('/admin/categories'), get('/admin/users'), get('/admin/outbox'), get('/admin/sla'),
    get('/admin/templates'), get('/admin/calendar'), get('/admin/audit'), get('/admin/targets'), get('/admin/integrations'),
    get('/admin/work-hours'), get('/admin/timezone'),
  ]);
  const staff = users.filter((u) => u.role !== 'employee' && u.isActive);
  const reload = async () => { await refreshMeta(); rerender(); };
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Настройки'), h('p', null, 'Категории и маршрутизация, пользователи, сроки, праздники, интеграции, шаблоны ответов. Каждое изменение попадает в журнал.'))),
    meta.demoMode && demoCard(),
    categoriesCard(categories, staff, reload),
    usersAdminCard(users, me, reload),
    h('div', { class: 'an-grid admin-pair' }, slaCard(sla, reload, workHours, timezone), holidaysCard(holidays, reload)),
    targetsCard(targets, reload),
    integrationsCard(integrations, reload, outbox.filter((o) => o.channel === 'email')),
    templatesCard(templates, reload),
    h('div', { class: 'an-grid admin-pair' }, outboxCard(outbox.filter((o) => o.channel === 'bitrix24'), integrations, reload), auditCard(auditLog)));
}
