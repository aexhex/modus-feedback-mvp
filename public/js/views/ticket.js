import { h, mount, toast, badge, slaChip, fmtDate, fileToBase64 } from '../dom.js';
import { get, post } from '../api.js';
import { processingCard } from './ticket-panels.js';

const EVENT_TITLES = {
  created: () => 'Обращение создано',
  assigned: () => 'Назначение ответственного',
  status: (e) => (e.fromStatusLabel ? `Статус: ${e.fromStatusLabel} → ${e.toStatusLabel}` : `Статус: ${e.toStatusLabel}`),
  comment: () => 'Комментарий',
  support: () => 'Поддержка коллег',
  attachment: () => 'Вложение',
  priority: () => 'Изменение приоритета',
  escalation: () => 'Эскалация: нарушен срок',
  feedback: () => 'Оценка автора',
};

function timeline(events) {
  return h('ol', { class: 'timeline' }, events.map((e) =>
    h('li', { class: `tl-item k-${e.kind} ${e.isInternal ? 'internal' : ''}` },
      h('span', { class: 'tl-dot' }),
      h('div', null, h('b', null, (EVENT_TITLES[e.kind] ?? (() => e.kind))(e)), e.isInternal && h('span', { class: 'tag-internal' }, 'Внутренняя заметка')),
      h('div', { class: 'tl-meta' }, `${e.actorName} · ${fmtDate(e.createdAt)}`),
      e.body && h('div', { class: 'tl-body' }, e.body))));
}

function commentForm(t, me, reload) {
  const body = h('textarea', { rows: 3, placeholder: 'Ваш комментарий', maxlength: 3000 });
  const internal = h('input', { type: 'checkbox' });
  const isAuthorWaiting = t.status === 'need_info' && t.author?.id === me.id;
  return h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/tickets/${t.id}/comments`, { body: body.value, internal: internal.checked });
      toast(isAuthorWaiting ? 'Уточнение отправлено — обращение снова на рассмотрении' : 'Комментарий добавлен', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  } },
  isAuthorWaiting && h('div', { class: 'callout' }, 'Ответственный ждёт уточнения. Ответьте здесь — обращение автоматически вернётся на рассмотрение.'),
  body,
  h('div', { class: 'row' },
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Отправить'),
    t.permissions.canProcess && h('label', { class: 'check' }, internal, 'Внутренняя заметка (не видна автору)')));
}

function attachmentsBlock(t, reload) {
  const input = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx,.csv', onchange: async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      await post(`/tickets/${t.id}/attachments`, { name: file.name, dataBase64: await fileToBase64(file) });
      toast('Файл прикреплён', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  } });
  return h('section', { class: 'card' },
    h('h3', null, `Материалы (${t.attachments.length})`),
    t.attachments.map((a) => h('div', { class: 'attach' },
      h('a', { href: `/api/attachments/${a.id}` }, a.name), h('span', { class: 'muted' }, `${Math.ceil(a.size / 1024)} КБ`))),
    t.permissions.canComment && h('div', { style: { marginTop: '10px' } }, input));
}

function factsCard(t, reload) {
  const supportBtn = t.permissions.canSupport && !['implemented', 'rejected', 'closed'].includes(t.status)
    && h('button', { class: 'btn btn-sm', onclick: async () => {
      try { await post(`/tickets/${t.id}/support`); toast('Вы поддержали обращение', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
    } }, '+ Поддержать');
  const fact = (k, v) => [h('dt', null, k), h('dd', null, v)];
  return h('section', { class: 'card' },
    h('h3', null, 'Сведения'),
    h('dl', { class: 'facts' },
      fact('Категория', t.category.name),
      fact('Автор', t.author ? t.author.name : 'Скрыт (анонимно)'),
      fact('Подразделение', t.department ?? 'Скрыто (анонимно)'),
      fact('Ответственный', t.assignee?.name ?? 'Не назначен'),
      fact('Создано', fmtDate(t.createdAt)),
      fact('Первый ответ', t.firstResponseAt ? fmtDate(t.firstResponseAt) : `до ${fmtDate(t.firstResponseDue)}`),
      fact('Срок решения', fmtDate(t.dueAt)),
      t.resolvedAt && fact('Решено', fmtDate(t.resolvedAt)),
      fact('Поддержали', String(t.supportsCount))),
    supportBtn && h('div', { style: { marginTop: '12px' } }, supportBtn));
}

// Автор подтверждает, решён ли вопрос, — метрика качества, а не только скорости.
function ratingBlock(t, reload) {
  if (t.feedback) {
    return h('section', { class: `card rating ${t.feedback.isResolved ? 'yes' : 'no'}` },
      h('h3', null, 'Оценка автора'),
      h('b', null, t.feedback.isResolved ? 'Вопрос решён' : 'Вопрос не решён'),
      t.feedback.comment && h('div', { class: 'text-block muted' }, t.feedback.comment));
  }
  if (!t.permissions.canRate) return null;
  const comment = h('textarea', { rows: 2, placeholder: 'Комментарий (необязательно)', maxlength: 3000 });
  const send = (isResolved) => async () => {
    try {
      await post(`/tickets/${t.id}/feedback`, { isResolved, comment: comment.value });
      toast('Спасибо, оценка учтена', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('section', { class: 'card rating stack' },
    h('h3', null, 'Ваш вопрос решён?'),
    comment,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', onclick: send(true) }, 'Да, решён'),
      h('button', { class: 'btn', onclick: send(false) }, 'Нет, не решён')));
}

export async function renderTicket(el, { me, meta, params, rerender }) {
  const t = await get(`/tickets/${params[0]}`);
  const reload = () => rerender();
  mount(el,
    h('a', { href: '#/tickets?scope=mine', class: 'btn btn-ghost btn-sm', onclick: (e) => { e.preventDefault(); history.back(); } }, '← Назад'),
    h('header', { class: 't-head' },
      h('div', { class: 'row' }, h('span', { class: 't-code' }, t.code), badge('status', t.status, t.statusLabel),
        badge('type', t.type, t.typeLabel), badge('priority', t.priority, t.priorityLabel), slaChip(t), t.isAnonymous && h('span', { class: 'chip' }, 'Анонимно')),
      h('h1', null, t.title)),
    h('div', { class: 'grid-2' },
      h('div', null,
        t.resolution && h('section', { class: `card resolution ${t.status === 'rejected' ? 'rejected' : ''}` },
          h('h3', null, t.status === 'rejected' ? 'Мотивированный отказ' : 'Результат рассмотрения'),
          h('div', { class: 'text-block' }, t.resolution),
          t.duplicateOf && h('p', null, 'Исходное обращение: ', h('a', { href: `#/t/${t.duplicateOf.id}` }, `${t.duplicateOf.code} — ${t.duplicateOf.title}`))),
        ratingBlock(t, reload),
        h('section', { class: 'card' },
          h('h3', null, 'Описание'), h('div', { class: 'text-block' }, t.description),
          t.proposedSolution && [h('h3', { style: { marginTop: '18px' } }, 'Предлагаемое решение'), h('div', { class: 'text-block' }, t.proposedSolution)]),
        attachmentsBlock(t, reload),
        h('section', { class: 'card' },
          h('h3', null, 'История и обсуждение'), timeline(t.events),
          t.permissions.canComment ? commentForm(t, me, reload) : h('p', { class: 'muted' }, 'Обращение закрыто — обсуждение завершено.'))),
      h('div', null, factsCard(t, reload), processingCard(t, meta, reload))));
}
