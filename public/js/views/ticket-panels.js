// Панели обработки обращения: смена статуса, приоритет, переназначение, дубликат.
import { h, toast, field, options } from '../dom.js';
import { post } from '../api.js';

const FINAL = ['implemented', 'rejected', 'closed'];

function run(action, onDone) {
  return async (e) => {
    e.preventDefault();
    const btn = e.submitter ?? e.target.querySelector('button');
    if (btn) btn.disabled = true;
    try {
      await action();
      onDone();
    } catch (err) {
      toast(err.message, 'error');
      if (btn) btn.disabled = false;
    }
  };
}

function statusForm(t, meta, onDone) {
  const statusIn = h('select', { 'aria-label': 'Новый статус' }, options(t.permissions.allowedStatuses, { empty: 'Выберите новый статус' }));
  const commentIn = h('textarea', { rows: 3, placeholder: 'Комментарий для автора' });
  const resolutionIn = h('textarea', { rows: 3, placeholder: 'Что решено и что сделано' });
  const resolutionField = field('Результат рассмотрения', resolutionIn, 'Обязателен для итоговых статусов — автор увидит его');
  resolutionField.hidden = true;
  const hint = h('div', { class: 'field-hint' });
  // Шаблон подставляет текст в комментарий или в результат — его можно дописать перед отправкой.
  const templateIn = h('select', { 'aria-label': 'Шаблон ответа', onchange: () => {
    const found = meta.templates.find((x) => String(x.id) === templateIn.value);
    templateIn.value = '';
    if (!found) return;
    if (found.field === 'resolution') {
      resolutionField.hidden = false;
      resolutionIn.value = found.text;
    } else {
      commentIn.value = found.text;
    }
  } }, options(meta.templates.map((x) => ({ key: x.id, label: x.title })), { empty: 'Вставить шаблон ответа…' }));
  statusIn.addEventListener('change', () => {
    const s = statusIn.value;
    resolutionField.hidden = !FINAL.includes(s);
    if (t.resolution && !resolutionIn.value) resolutionIn.value = t.resolution;
    hint.textContent = s === 'need_info' ? 'Сформулируйте вопрос в комментарии — после ответа автора обращение вернётся на рассмотрение.' : '';
  });
  return h('form', { class: 'stack', onsubmit: run(async () => {
    if (!statusIn.value) throw new Error('Выберите статус');
    await post(`/tickets/${t.id}/status`, {
      status: statusIn.value, comment: commentIn.value,
      resolution: FINAL.includes(statusIn.value) ? resolutionIn.value : '',
    });
    toast('Статус обновлён, автор уведомлён', 'success');
  }, onDone) },
  statusIn, hint, templateIn, field('Комментарий', commentIn), resolutionField,
  h('button', { class: 'btn btn-primary', type: 'submit' }, 'Применить'));
}

function priorityForm(t, meta, onDone) {
  const sel = h('select', { value: t.priority }, options(meta.priorities));
  return h('form', { class: 'row', onsubmit: run(() => post(`/tickets/${t.id}/priority`, { priority: sel.value }), onDone) },
    h('div', { style: { flex: '1' } }, sel), h('button', { class: 'btn btn-sm', type: 'submit' }, 'Сохранить'));
}

function assignForm(t, meta, onDone) {
  const sel = h('select', { value: t.assignee ? String(t.assignee.id) : '' },
    options(meta.staff.map((u) => ({ key: u.id, label: `${u.name}${u.isAvailable ? '' : ' (отсутствует)'}` })), { empty: 'Выберите ответственного' }));
  const reason = h('input', { type: 'text', placeholder: 'Причина (необязательно)' });
  return h('form', { class: 'stack', onsubmit: run(async () => {
    await post(`/tickets/${t.id}/assign`, { assigneeId: Number(sel.value), reason: reason.value });
    toast('Ответственный изменён', 'success');
  }, onDone) }, sel, reason, h('button', { class: 'btn btn-sm', type: 'submit' }, 'Переназначить'));
}

function duplicateForm(t, onDone) {
  const code = h('input', { type: 'text', placeholder: 'Номер исходного, напр. A-003' });
  return h('form', { class: 'row', onsubmit: run(async () => {
    await post(`/tickets/${t.id}/duplicate`, { code: code.value });
    toast('Обращение объединено с исходным', 'success');
  }, onDone) }, h('div', { style: { flex: '1' } }, code), h('button', { class: 'btn btn-sm', type: 'submit' }, 'Объединить'));
}

// Задача уходит в Битрикс24 (tasks.task.add); без подключения к порталу — только запись в журнал.
function taskBlock(t, meta, onDone) {
  if (t.b24Task) return h('p', { class: 'muted' }, t.b24Task.text);
  if (!t.permissions.canCreateTask) return h('p', { class: 'muted' }, 'Доступно для обращений в работе.');
  const live = meta.b24Mode !== 'off';
  return h('form', { onsubmit: run(async () => {
    await post(`/tickets/${t.id}/b24-task`);
    toast(live ? 'Задача отправлена в Битрикс24 — номер появится в истории' : 'Задача создана (имитация) — запись в журнале Битрикс24', 'success');
  }, onDone) }, h('button', { class: 'btn btn-sm', type: 'submit' }, live ? 'Создать задачу в Битрикс24' : 'Создать задачу (имитация)'));
}

function inviteForm(t, meta, onDone) {
  const taken = new Set([t.assignee?.id, ...t.watchers.map((w) => w.id)]);
  const candidates = meta.staff.filter((u) => !taken.has(u.id)).map((u) => ({ key: u.id, label: u.name }));
  const sel = h('select', { 'aria-label': 'Коллега' }, options(candidates, { empty: 'Выберите коллегу' }));
  return h('form', { class: 'row', onsubmit: run(async () => {
    if (!sel.value) throw new Error('Выберите коллегу');
    await post(`/tickets/${t.id}/invite`, { userId: Number(sel.value) });
    toast('Коллега приглашён в обсуждение', 'success');
  }, onDone) }, h('div', { style: { flex: '1' } }, sel), h('button', { class: 'btn btn-sm', type: 'submit' }, 'Пригласить'));
}

// Отчёт о внедрении: что сделано и какой получен эффект. Публикуется на доске улучшений.
function reportForm(t, onDone) {
  const done = h('textarea', { rows: 2, maxlength: 3000, placeholder: 'Что именно сделано' }, t.report?.done ?? '');
  const effect = h('textarea', { rows: 2, maxlength: 3000, placeholder: 'Что изменилось: время, ошибки, удобство' }, t.report?.effect ?? '');
  return h('form', { class: 'stack', onsubmit: run(async () => {
    await post(`/tickets/${t.id}/report`, { done: done.value, effect: effect.value });
    toast('Отчёт о внедрении опубликован', 'success');
  }, onDone) }, field('Что сделано', done), field('Эффект', effect),
  h('button', { class: 'btn btn-sm', type: 'submit' }, t.report ? 'Обновить отчёт' : 'Опубликовать отчёт'));
}

export function processingCard(t, meta, onDone) {
  const p = t.permissions;
  if (!p.canProcess) return null;
  const open = !FINAL.includes(t.status);
  return h('section', { class: 'card stack' },
    h('h3', null, 'Рассмотрение'),
    t.isPublic && h('div', { class: 'callout' }, 'Обращение открыто в «Идеях коллег»: ваши ответы, результат и приложенные файлы видят все сотрудники. Для служебного используйте внутренние заметки.'),
    p.allowedStatuses.length ? statusForm(t, meta, onDone) : h('p', { class: 'muted' }, 'Обращение закрыто.'),
    p.canReport && h('div', { class: 'stack' }, h('h3', null, 'Отчёт о внедрении'), reportForm(t, onDone)),
    // Редкие действия свёрнуты, чтобы на виду оставалось главное: статус и результат.
    h('details', { class: 'more-actions' },
      h('summary', null, 'Ещё действия'),
      h('div', { class: 'stack' },
        open && h('div', { class: 'stack' }, h('h3', null, 'Приоритет и SLA'), priorityForm(t, meta, onDone)),
        p.canReassign && h('div', { class: 'stack' }, h('h3', null, 'Ответственный'), assignForm(t, meta, onDone)),
        p.canInvite && h('div', { class: 'stack' }, h('h3', null, 'Позвать коллегу'), inviteForm(t, meta, onDone)),
        h('div', { class: 'stack' }, h('h3', null, 'Задача в Битрикс24'), taskBlock(t, meta, onDone)),
        open && h('div', { class: 'stack' }, h('h3', null, 'Повторное обращение'), duplicateForm(t, onDone)))));
}
