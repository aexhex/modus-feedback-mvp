// Обратная связь от клиентов: публичная форма (без входа) и раздел для руководителя.
import { h, mount, toast, field, fmtDate, themeToggle } from '../dom.js';
import { get, post, patch } from '../api.js';

const SCORES = Array.from({ length: 11 }, (_, i) => i);
const scoreClass = (score) => (score >= 9 ? 'score-good' : score >= 7 ? 'score-mid' : 'score-bad');

/** Страница для клиента: открывается по ссылке, вход не нужен. */
export function renderClientForm(root) {
  const name = h('input', { type: 'text', maxlength: 100, autocomplete: 'name' });
  const company = h('input', { type: 'text', maxlength: 150, autocomplete: 'organization' });
  const contact = h('input', { type: 'text', maxlength: 150, placeholder: 'Телефон или e-mail, если ждёте ответа' });
  const message = h('textarea', { rows: 5, maxlength: 2000, required: true, placeholder: 'Что понравилось, а что стоит улучшить?' });
  // Поле-ловушка: человеку не видно, автоматические отправители его заполняют.
  const trap = h('input', { type: 'text', name: 'website', tabindex: -1, autocomplete: 'off', class: 'trap', 'aria-hidden': 'true' });
  const done = h('div', { class: 'card empty', hidden: true }, 'Спасибо! Ваш отзыв получен.');
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const score = form.querySelector('input[name="score"]:checked')?.value;
    try {
      await post('/public/feedback', { name: name.value, company: company.value, contact: contact.value, score: Number(score), message: message.value, website: trap.value });
      form.hidden = true;
      done.hidden = false;
    } catch (err) { toast(err.message, 'error'); }
  } },
  h('fieldset', { class: 'scale' },
    h('legend', { class: 'field-label' }, 'Насколько вероятно, что вы порекомендуете нас коллегам?'),
    h('div', { class: 'scale-options' },
      h('span', { class: 't-sub' }, 'точно нет'),
      SCORES.map((v) => h('label', { class: 'scale-option' }, h('input', { type: 'radio', name: 'score', value: String(v), required: true }), h('span', null, String(v)))),
      h('span', { class: 't-sub' }, 'обязательно'))),
  field('Ваш отзыв', message),
  h('div', { class: 'client-contacts' }, field('Как к вам обращаться', name), field('Компания', company), field('Контакт для ответа', contact)),
  trap,
  h('div', { class: 'row' }, h('button', { class: 'btn btn-signal', type: 'submit' }, 'Отправить отзыв'),
    h('span', { class: 't-sub' }, 'Контактные данные необязательны.')));
  mount(root,
    h('div', { class: 'login client-page' },
      h('div', { class: 'login-top' }, themeToggle()),
      h('h3', null, 'ГК «Модус Трейд»'),
      h('h1', null, 'Оцените работу с нами'),
      h('p', { class: 'login-note' }, 'Отзыв увидят руководители компании. Он помогает понять, что работает хорошо, а что нужно исправить.'),
      form, done,
      h('p', null, h('a', { href: '#/login', class: 't-sub' }, 'Вход для сотрудников'))));
}

/** Раздел руководителя: NPS и список отзывов. */
export async function renderClients(el, { rerender }) {
  const { items, nps } = await get('/client-feedback');
  const mark = (item) => async () => {
    try {
      await patch(`/client-feedback/${item.id}`, { status: item.status === 'new' ? 'processed' : 'new' });
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  };
  const tile = (value, label) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-label' }, label));
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Отзывы клиентов'),
        h('p', null, 'Клиент оставляет отзыв по ссылке без входа в систему. NPS = доля промоутеров (9–10) минус доля критиков (0–6).')),
      h('a', { class: 'btn', href: '#/client', target: '_blank', rel: 'noopener' }, 'Открыть форму для клиента')),
    h('div', { class: 'kpis' },
      tile(nps.value === null ? '—' : String(nps.value), 'NPS'),
      tile(String(nps.count), 'Всего отзывов'),
      tile(String(nps.promoters), 'Промоутеры (9–10)'),
      tile(String(nps.passives), 'Нейтральные (7–8)'),
      tile(String(nps.detractors), 'Критики (0–6)')),
    items.length === 0
      ? h('div', { class: 'card empty' }, 'Отзывов пока нет')
      : h('div', { class: 'card' }, h('ul', { class: 'list-plain' }, items.map((item) => h('li', { class: 'client-item' },
        h('span', { class: `nps-score ${scoreClass(item.score)}` }, String(item.score)),
        h('div', { class: 'client-body' },
          h('div', { class: 'text-block' }, item.message),
          h('div', { class: 't-sub' }, [item.name, item.company, item.contact, fmtDate(item.createdAt)].filter(Boolean).join(' · '))),
        h('button', { class: `btn btn-sm ${item.status === 'new' ? 'btn-primary' : 'btn-ghost'}`, onclick: mark(item) },
          item.status === 'new' ? 'Отметить разобранным' : '✓ Разобран'))))));
}
