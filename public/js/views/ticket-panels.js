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

function statusForm(t, onDone) {
  const statusIn = h('select', null, options(t.permissions.allowedStatuses, { empty: 'Выберите новый статус' }));
  const commentIn = h('textarea', { rows: 3, placeholder: 'Комментарий для автора' });
  const resolutionIn = h('textarea', { rows: 3, placeholder: 'Что решено и что сделано' });
  const resolutionField = field('Результат рассмотрения', resolutionIn, 'Обязателен для итоговых статусов — автор увидит его');
  resolutionField.hidden = true;
  const hint = h('div', { class: 'field-hint' });
  statusIn.addEventListener('change', () => {
    const s = statusIn.value;
    resolutionField.hidden = !FINAL.includes(s);
    if (t.resolution && !resolutionIn.value) resolutionIn.value = t.resolution;
    hint.textContent = s === 'need_info' ? 'Сформулируйте вопрос в комментарии — после ответа автора обращение вернётся на рассмотрение.' : '';
  });
  return h('form', { class: 'stack', onsubmit: run(async () => {
    if (!statusIn.value) throw new Error('Выберите статус');
    await post(`/tickets/${t.id}/status`, { status: statusIn.value, comment: commentIn.value, resolution: resolutionIn.value });
    toast('Статус обновлён, автор уведомлён', 'success');
  }, onDone) },
  statusIn, hint, field('Комментарий', commentIn), resolutionField,
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

export function processingCard(t, meta, onDone) {
  const p = t.permissions;
  if (!p.canProcess) return null;
  const open = !FINAL.includes(t.status);
  return h('section', { class: 'card stack' },
    h('h3', null, 'Рассмотрение'),
    p.allowedStatuses.length ? statusForm(t, onDone) : h('p', { class: 'muted' }, 'Обращение закрыто.'),
    open && h('div', { class: 'stack' }, h('h3', null, 'Приоритет и SLA'), priorityForm(t, meta, onDone)),
    p.canReassign && h('div', { class: 'stack' }, h('h3', null, 'Ответственный'), assignForm(t, meta, onDone)),
    open && h('div', { class: 'stack' }, h('h3', null, 'Повторное обращение'), duplicateForm(t, onDone)));
}
