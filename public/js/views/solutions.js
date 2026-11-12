// База решений: что уже решили по похожим вопросам и почему — чтобы не решать одно и то же дважды.
import { h, mount, debounce, options, fmtShort, badge } from '../dom.js';
import { get, qs } from '../api.js';

const SEARCH_DELAY_MS = 300;
const OUTCOME_TABS = [
  { key: '', label: 'Все итоги' },
  { key: 'implemented', label: 'Реализовано' },
  { key: 'rejected', label: 'Отклонено' },
];

function solutionCard(s) {
  return h('article', { class: `solution solution-${s.outcome}` },
    h('div', { class: 'row' },
      h('span', { class: 't-code' }, s.code), badge('status', s.outcome, s.outcomeLabel),
      h('span', { class: 'chip' }, s.category.name), h('span', { class: 't-sub' }, s.typeLabel)),
    h('h3', null, s.title),
    h('div', { class: 'solution-answer' },
      h('span', { class: 'solution-label' }, s.outcome === 'rejected' ? 'Почему отказали' : 'Что решили'),
      h('div', { class: 'text-block' }, s.resolution)),
    s.report && h('div', { class: 'solution-answer' },
      h('span', { class: 'solution-label' }, 'Что сделано и эффект'),
      h('div', { class: 'text-block' }, `${s.report.done} ${s.report.effect ?? ''}`.trim())),
    h('div', { class: 'row home-between' },
      h('span', { class: 't-sub' }, `Итог от ${fmtShort(s.resolvedAt)}`),
      s.canOpen && h('a', { class: 'btn btn-sm btn-ghost', href: `#/t/${s.id}` }, 'Открыть обращение')));
}

export async function renderSolutions(el, { meta, query }) {
  const state = { q: query.q ?? '', category: query.category ?? '', outcome: query.outcome ?? '' };
  const results = h('div', { 'aria-live': 'polite' });
  const load = async () => {
    const list = await get(`/solutions${qs(state)}`);
    mount(results,
      h('p', { class: 't-sub' }, `Найдено: ${list.length}`),
      list.length === 0
        ? h('div', { class: 'card empty' }, state.q ? 'По этому запросу решений пока нет — значит, вопрос новый.' : 'Пока нет рассмотренных обращений с итогом')
        : h('div', { class: 'solutions-grid' }, list.map(solutionCard)));
  };
  // Вкладки итога и фильтры сохраняются в адресе: ссылкой на подборку можно поделиться.
  const syncUrl = () => history.replaceState(null, '', `#/solutions${qs(state)}`);
  const update = () => { syncUrl(); load(); };
  const search = h('input', {
    type: 'search', value: state.q, placeholder: 'Поиск по теме и решению: например, «шаблон заявки»',
    'aria-label': 'Поиск по базе решений',
    oninput: debounce((e) => { state.q = e.target.value.trim(); update(); }, SEARCH_DELAY_MS),
  });
  const category = h('select', {
    'aria-label': 'Категория',
    onchange: (e) => { state.category = e.target.value; update(); },
  }, options(meta.categories, { valueKey: 'id', labelKey: 'name', empty: 'Все категории' }));
  category.value = state.category;
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Итог рассмотрения' }, OUTCOME_TABS.map((t) => h('a', {
    href: `#/solutions${qs({ ...state, outcome: t.key })}`,
    class: state.outcome === t.key ? 'active' : '',
    'aria-current': state.outcome === t.key ? 'page' : null,
  }, t.label)));

  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'База решений'),
        h('p', null, 'Что уже решили по обращениям коллег и почему. Прежде чем подавать или рассматривать вопрос, проверьте — возможно, ответ уже есть. Имена авторов не показываются.'))),
    tabs,
    h('div', { class: 'row solutions-filters' }, search, category),
    results);
  await load();
}
