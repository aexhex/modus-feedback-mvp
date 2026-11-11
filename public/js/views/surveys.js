// Опросы сотрудников: список, прохождение, результаты (сводно, без имён) и создание.
import { h, mount, toast, field, fmtDate } from '../dom.js';
import { get, post, patch } from '../api.js';

const SCALE = [1, 2, 3, 4, 5];
const lines = (value) => value.split('\n').map((s) => s.trim()).filter(Boolean);

function createForm(reload) {
  const title = h('input', { type: 'text', maxlength: 120, required: true, placeholder: 'Например: оценка адаптации новых сотрудников' });
  const description = h('input', { type: 'text', maxlength: 500, placeholder: 'Зачем опрос и что будет с результатами' });
  const scale = h('textarea', { rows: 3, placeholder: 'Каждый вопрос с новой строки' });
  const open = h('textarea', { rows: 2, placeholder: 'Каждый вопрос с новой строки' });
  return h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post('/surveys', { title: title.value, description: description.value, scaleQuestions: lines(scale.value), textQuestions: lines(open.value) });
      toast('Опрос опубликован', 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  } },
  h('h3', null, 'Новый опрос'),
  field('Название', title), field('Пояснение для сотрудников', description),
  field('Вопросы с оценкой от 1 до 5', scale), field('Открытые вопросы', open),
  h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Опубликовать опрос')));
}

async function renderList(el, { me, rerender }) {
  const isOversight = me.role === 'manager' || me.role === 'admin';
  const surveys = await get('/surveys');
  const toggle = (s) => async () => {
    try {
      await patch(`/surveys/${s.id}`, { isOpen: !s.isOpen });
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  };
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Опросы'),
        h('p', null, 'Ответы анонимны: руководитель видит только сводные результаты — после закрытия опроса и если ответивших не меньше трёх.'))),
    surveys.length === 0
      ? h('div', { class: 'card empty' }, 'Сейчас открытых опросов нет')
      : h('div', { class: 'board-grid' }, surveys.map((s) => h('article', { class: `win survey-card ${s.isOpen ? '' : 'survey-closed'}` },
        h('b', null, s.title),
        s.description && h('div', { class: 'muted' }, s.description),
        h('div', { class: 't-sub' }, `${fmtDate(s.createdAt)}${s.isOpen ? '' : ' · закрыт'}${s.respondents === undefined ? '' : ` · ответили: ${s.respondents}`}`),
        h('div', { class: 'row' },
          s.isOpen && (s.answered
            ? h('span', { class: 'chip' }, '✓ Вы прошли этот опрос')
            : h('a', { class: 'btn btn-sm btn-primary', href: `#/surveys/${s.id}` }, 'Пройти опрос')),
          isOversight && h('a', { class: 'btn btn-sm', href: `#/surveys/${s.id}/results` }, 'Результаты'),
          isOversight && s.isOpen && h('button', { class: 'btn btn-sm btn-ghost', title: 'После закрытия открыть опрос заново нельзя', onclick: toggle(s) }, 'Закрыть и подвести итоги'))))),
    isOversight && h('div', { class: 'survey-create' }, createForm(rerender)));
}

async function renderTake(el, id, { go }) {
  const survey = await get(`/surveys/${id}`);
  if (survey.answered || !survey.isOpen) {
    mount(el, h('div', { class: 'card empty' }, survey.answered ? 'Вы уже прошли этот опрос. Спасибо!' : 'Опрос закрыт.'),
      h('a', { class: 'btn btn-sm', href: '#/surveys' }, '← К опросам'));
    return;
  }
  const answers = new Map();
  const question = (q, index) => {
    if (q.kind === 'text') {
      const input = h('textarea', { rows: 3, maxlength: 1000, placeholder: 'Необязательно' });
      answers.set(q.id, () => input.value);
      return h('div', { class: 'field' }, h('span', { class: 'field-label' }, `${index + 1}. ${q.text}`), input);
    }
    const name = `q${q.id}`;
    answers.set(q.id, () => el.querySelector(`input[name="${name}"]:checked`)?.value);
    return h('fieldset', { class: 'scale' },
      h('legend', { class: 'field-label' }, `${index + 1}. ${q.text}`),
      h('div', { class: 'scale-options' },
        h('span', { class: 't-sub' }, 'плохо'),
        SCALE.map((v) => h('label', { class: 'scale-option' }, h('input', { type: 'radio', name, value: String(v), required: true }), h('span', null, String(v)))),
        h('span', { class: 't-sub' }, 'отлично')));
  };
  mount(el,
    h('a', { href: '#/surveys', class: 'btn btn-ghost btn-sm' }, '← К опросам'),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, survey.title), survey.description && h('p', null, survey.description))),
    h('form', { class: 'card stack survey-form', onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries([...answers.entries()].map(([qid, read]) => [qid, read()]));
      try {
        await post(`/surveys/${id}/answers`, { answers: body });
        toast('Спасибо, ответы приняты', 'success');
        go('#/surveys');
      } catch (err) { toast(err.message, 'error'); }
    } },
    survey.questions.map(question),
    h('div', null, h('button', { class: 'btn btn-signal', type: 'submit' }, 'Отправить ответы'))));
}

async function renderResults(el, id) {
  const r = await get(`/surveys/${id}/results`);
  const scaleBlock = (q) => {
    const max = Math.max(1, ...q.distribution.map((d) => d.count));
    return h('section', { class: 'card' },
      h('h3', null, q.text),
      h('div', { class: 'row' }, h('div', { class: 'kpi-value' }, String(q.average)), h('span', { class: 'muted' }, 'средняя оценка из 5')),
      h('div', { class: 'bars', style: { marginTop: '10px' } }, q.distribution.map((d) => h('div', { class: 'bar-row' },
        h('span', null, `Оценка ${d.value}`),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(d.count / max) * 100}%` } })),
        h('span', { class: 'bar-num' }, String(d.count))))));
  };
  const textBlock = (q) => h('section', { class: 'card' },
    h('h3', null, q.text),
    q.answersHidden ? h('p', { class: 'muted' }, 'Ответов меньше трёх — скрыты, чтобы нельзя было вычислить автора')
      : q.answers.length === 0 ? h('p', { class: 'muted' }, 'Ответов нет') : h('ul', { class: 'list-plain' }, q.answers.map((a) => h('li', null, a))));
  mount(el,
    h('a', { href: '#/surveys', class: 'btn btn-ghost btn-sm' }, '← К опросам'),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, r.title), h('p', null, `Ответили: ${r.respondents}${r.isOpen ? '' : ' · опрос закрыт'}`))),
    r.hidden
      ? h('div', { class: 'card empty' }, r.reason === 'open'
        ? 'Результаты появятся после закрытия опроса: пока он идёт, по изменению итогов можно было бы вычислить отвечавших.'
        : `Ответили меньше ${r.threshold} человек — результаты скрыты, чтобы нельзя было вычислить, кто что написал.`)
      : h('div', { class: 'an-grid' }, r.questions.map((q) => (q.kind === 'scale' ? scaleBlock(q) : textBlock(q)))));
}

export async function renderSurveys(el, ctx) {
  const [id, results] = ctx.params;
  if (!id) return renderList(el, ctx);
  return results ? renderResults(el, id) : renderTake(el, id, ctx);
}
