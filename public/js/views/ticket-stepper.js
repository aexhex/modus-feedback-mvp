// Шкала этапов обращения: Подано → На рассмотрении → В работе → Итог.
// Показывает автору путь обращения без чтения истории: пройденное, текущее и сроки следующего шага.
import { h, fmtShort } from '../dom.js';

const FINAL = ['implemented', 'rejected', 'closed'];
const REVIEW = ['in_review', 'need_info'];
const STATE_TEXT = { done: 'пройден', current: 'текущий этап', todo: 'впереди', skipped: 'не потребовался' };

const firstAt = (events, statuses) => events.find((e) => e.kind === 'status' && statuses.includes(e.toStatus))?.createdAt ?? null;

function steps(t) {
  const final = FINAL.includes(t.status);
  const reviewedAt = t.firstResponseAt ?? firstAt(t.events, [...REVIEW, 'in_progress', ...FINAL]);
  const workAt = firstAt(t.events, ['in_progress']);
  const late = (kind) => t.sla?.overdue && t.sla.kind === kind;

  const review = t.status === 'new'
    ? { state: 'current', note: `ответ до ${fmtShort(t.firstResponseDue)}`, late: late('first_response') }
    : REVIEW.includes(t.status)
      ? { state: 'current', note: t.status === 'need_info' ? 'ждём уточнения от автора' : `с ${fmtShort(reviewedAt)}` }
      : { state: 'done', note: fmtShort(reviewedAt) };
  const work = t.status === 'in_progress'
    ? { state: 'current', note: `с ${fmtShort(workAt)}` }
    : workAt && final ? { state: 'done', note: fmtShort(workAt) }
      : final ? { state: 'skipped', note: 'не потребовалось' } : { state: 'todo', note: '' };
  const outcome = final
    ? { state: 'done', label: t.statusLabel, note: fmtShort(t.resolvedAt), kind: t.status }
    : { state: 'todo', label: 'Итог', note: `решение до ${fmtShort(t.dueAt)}`, late: late('resolve') };

  return [
    { label: 'Подано', state: 'done', note: fmtShort(t.createdAt) },
    { label: t.status === 'need_info' ? 'Ожидает уточнения' : 'На рассмотрении', ...review },
    { label: 'В работе', ...work },
    outcome,
  ];
}

export function ticketStepper(t) {
  return h('ol', { class: 'stepper', 'aria-label': 'Этапы рассмотрения' }, steps(t).map((s, i) => h('li', {
    class: `step-${s.state} ${s.late ? 'step-late' : ''} ${s.kind ? `step-${s.kind}` : ''}`,
    'aria-current': s.state === 'current' ? 'step' : null,
  },
  h('span', { class: 'step-dot', 'aria-hidden': 'true' }, s.state === 'done' ? '✓' : String(i + 1)),
  h('span', { class: 'step-text' },
    h('b', null, s.label),
    h('span', { class: 'visually-hidden' }, `: ${STATE_TEXT[s.state]}`),
    s.note && h('span', { class: 'step-note' }, s.late ? `${s.note} · просрочено` : s.note)))));
}
