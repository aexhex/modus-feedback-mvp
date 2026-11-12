// Интеграции с Битрикс24 и 1С УТ в «Настройках»: состояние подключения, загрузка оргструктуры
// и контрагентов, выгрузка для анализа и журнал отправки в Битрикс24.
import { h, toast } from '../dom.js';
import { locale, t } from '../i18n.js';
import { post } from '../api.js';

const MODE_LABELS = { live: 'Подключено', demo: 'Демо-портал', off: 'Не подключено — имитация' };
const MODE_HINTS = {
  b24: {
    live: 'Уведомления и задачи уходят на портал через входящий вебхук.',
    demo: 'Вызовы идут по HTTP на встроенный демо-портал, который отвечает как Битрикс24. Для настоящего портала задайте B24_WEBHOOK_URL.',
    off: 'Вызовы только записываются в журнал. Для отправки задайте B24_WEBHOOK_URL.',
  },
  onec: {
    live: 'Справочник контрагентов загружается через OData-интерфейс 1С.',
    demo: 'Справочник загружается со встроенного демо-сервера в формате OData 1С. Для настоящей базы задайте ONEC_ODATA_URL.',
    off: 'Не подключена. Для загрузки контрагентов задайте ONEC_ODATA_URL, ONEC_USER и ONEC_PASSWORD.',
  },
};
const OUTBOX_STATUS = {
  sent: ['Отправлено', 'status-implemented'],
  pending: ['В очереди', 'status-in_review'],
  sending: ['В очереди', 'status-in_review'],
  failed: ['Ошибка', 'status-rejected'],
  skipped: ['Не отправлено', 'status-need_info'],
  simulated: ['Имитация', 'status-closed'],
};
const ROLE_LABELS = { employee: 'Сотрудник', handler: 'Ответственный' };

const modeBadge = (mode) => h('span', { class: `badge ${mode === 'off' ? 'status-closed' : 'status-implemented'}` }, MODE_LABELS[mode]);

const busy = (button, action) => async () => {
  button.disabled = true;
  try { await action(); } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; }
};

function group(title, items, render) {
  if (items.length === 0) return null;
  return h('div', { class: 'sync-group' },
    h('b', null, `${t(title)}: ${items.length}`),
    h('ul', { class: 'list-plain' }, items.map((item) => h('li', null, render(item)))));
}

function orgPreview(p, applyBtn) {
  const empty = p.linked.length + p.created.length + p.moved.length + p.dismissed.length === 0;
  return h('div', { class: 'sync-preview', role: 'region', 'aria-label': 'Изменения из Битрикс24' },
    h('p', { class: 't-sub' }, `${t('На портале')}: ${p.portalUsers} ${t('сотрудников')}, ${p.departments} ${t('подразделений')}`),
    empty ? h('p', null, 'Изменений нет — данные совпадают с порталом.') : [
      p.linked.length > 0 && h('div', { class: 'sync-group' },
        h('b', null, `${t('Будут связаны с Битрикс24')}: ${p.linked.length}`), h('p', { class: 't-sub' }, p.linked.join(', '))),
      group('Новые сотрудники', p.created, (u) => [h('b', null, u.name), ` — ${t(u.department)}, ${t(ROLE_LABELS[u.role]).toLowerCase()}`]),
      group('Перевод в другое подразделение', p.moved, (u) => [h('b', null, u.name), `: ${t(u.from)} → ${t(u.to)}`]),
      p.dismissBlocked && p.dismissed.length > 0
        ? h('p', { class: 'outbox-error' }, 'С портала пришло подозрительно мало сотрудников — отключение уволенных пропущено, проверьте права вебхука')
        : group('Уволены — будут отключены, их обращения перейдут резервным', p.dismissed, (name) => name),
      applyBtn,
    ]);
}

function b24Block(info, reload) {
  const preview = h('div');
  const applyBtn = h('button', { class: 'btn btn-primary' }, 'Применить изменения');
  applyBtn.onclick = busy(applyBtn, async () => {
    const r = await post('/admin/integrations/b24/org-apply');
    toast(`${t('Оргструктура загружена')}: +${r.created}, ${t('переведено')} ${r.moved}, ${t('отключено')} ${r.dismissed}`, 'success');
    r.warnings.forEach((w) => toast(w, 'error'));
    reload();
  });
  const loadBtn = h('button', { class: 'btn', disabled: info.b24.mode === 'off' }, 'Загрузить оргструктуру');
  loadBtn.onclick = busy(loadBtn, async () => {
    preview.replaceChildren(orgPreview(await post('/admin/integrations/b24/org-preview'), applyBtn));
  });
  const s = info.outbox;
  return h('div', { class: 'integration' },
    h('div', { class: 'row' }, h('h4', null, 'Битрикс24'), modeBadge(info.b24.mode), info.b24.host && h('code', null, info.b24.host)),
    h('p', { class: 't-sub' }, MODE_HINTS.b24[info.b24.mode]),
    h('ul', { class: 'list-plain' },
      h('li', null, `${t('Сотрудников связано с порталом')}: ${info.linkedUsers}`),
      h('li', null, `${t('Отправлено')}: ${s.sent ?? 0} · ${t('В очереди')}: ${(s.pending ?? 0) + (s.sending ?? 0)} · ${t('Ошибка')}: ${s.failed ?? 0} · ${t('Не отправлено')}: ${s.skipped ?? 0}`)),
    h('p', { class: 't-sub' }, 'Оргструктура: сотрудники, подразделения и их руководители. Сначала показываются изменения, применяются после подтверждения.'),
    loadBtn, preview);
}

function exportBlock(info) {
  if (!info.export.enabled) return h('p', { class: 't-sub' }, 'Выключена. Чтобы включить, задайте ONEC_EXPORT_TOKEN.');
  return h('div', null,
    h('p', { class: 't-sub' }, 'Регламентное задание 1С забирает JSON без текста обращений и без авторов; у анонимных скрыто подразделение. Параметр since — только изменённые.'),
    h('code', { class: 'code-block' }, `GET ${info.exportUrl}?since=2026-01-01`),
    h('code', { class: 'code-block' }, `Authorization: Bearer ${info.export.demoToken ?? 'ONEC_EXPORT_TOKEN'}`),
    info.export.demoToken && h('p', { class: 't-sub' }, 'Токен демо-режима меняется при каждом запуске сервера.'));
}

function onecBlock(info, reload) {
  const loadBtn = h('button', { class: 'btn', disabled: info.onec.mode === 'off' }, 'Загрузить контрагентов');
  loadBtn.onclick = busy(loadBtn, async () => {
    const r = await post('/admin/integrations/1c/counterparties');
    toast(`${t('Клиентов в справочнике')}: ${r.total}`, 'success');
    reload();
  });
  return h('div', { class: 'integration' },
    h('div', { class: 'row' }, h('h4', null, '1С УТ'), modeBadge(info.onec.mode), info.onec.host && h('code', null, info.onec.host)),
    h('p', { class: 't-sub' }, MODE_HINTS.onec[info.onec.mode]),
    h('ul', { class: 'list-plain' }, h('li', null, `${t('Клиентов в справочнике')}: ${info.counterparties}`)),
    h('p', { class: 't-sub' }, 'Клиент выбирается при подаче обращения — так видно, с какими клиентами связаны проблемы.'),
    loadBtn,
    h('h4', { class: 'sub-h' }, 'Выгрузка обращений для анализа в 1С'),
    exportBlock(info));
}

export function integrationsCard(info, reload) {
  return h('section', { class: 'card' },
    h('h3', null, 'Интеграции с Битрикс24 и 1С УТ'),
    h('p', { class: 't-sub' }, 'Адреса и ключи подключения задаются переменными окружения на сервере и в интерфейсе не показываются.'),
    h('div', { class: 'an-grid admin-pair' }, b24Block(info, reload), onecBlock(info, reload)));
}

function outboxItem(o, reload) {
  const [label, cls] = OUTBOX_STATUS[o.status] ?? [o.status, 'status-closed'];
  const retryBtn = h('button', { class: 'btn btn-sm' }, 'Повторить');
  retryBtn.onclick = busy(retryBtn, async () => {
    await post(`/admin/outbox/${o.id}/retry`);
    toast('Запись поставлена в очередь', 'success');
    setTimeout(reload, 500);
  });
  return h('li', null,
    h('div', { class: 'row' },
      h('span', { class: 'chip' }, `${o.channel} · ${o.method}`), ' → ', h('b', null, o.recipient),
      h('span', { class: `badge ${cls}` }, label),
      o.externalId && h('span', { class: 't-sub' }, `ID ${o.externalId}`)),
    h('div', null, o.payload.MESSAGE ?? o.payload.TITLE),
    o.error && h('div', { class: 'outbox-error' }, o.error),
    h('div', { class: 'row' },
      h('span', { class: 't-sub' }, new Date(o.createdAt).toLocaleString(locale())),
      ['failed', 'skipped'].includes(o.status) && retryBtn));
}

// Журнал вызовов Битрикс24: что ушло на портал, что в очереди, что не удалось.
export function outboxCard(items, info, reload) {
  return h('section', { class: 'card' },
    h('h3', null, 'Журнал отправки в Битрикс24'),
    h('p', { class: 't-sub' }, info.b24.mode === 'off'
      ? 'Интеграция не подключена: здесь показано, какие вызовы система отправила бы на портал. Последние 50 записей.'
      : 'Вызовы im.notify и tasks.task.add. При ошибке система повторяет отправку до 5 раз. Последние 50 записей.'),
    items.length === 0 ? h('p', { class: 'muted' }, 'Пока пусто')
      : h('ul', { class: 'list-plain' }, items.map((o) => outboxItem(o, reload))));
}
