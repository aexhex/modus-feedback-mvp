import { h, mount, fmtDate } from '../dom.js';
import { get } from '../api.js';

export async function renderBoard(el) {
  const { implemented, openIdeas, topAuthors, authorOfMonth } = await get('/board');
  mount(el,
    h('section', { class: 'board-hero' },
      h('h1', null, 'Итоги внедрения: что изменилось благодаря вам'),
      h('p', null, `Реализовано улучшений: ${implemented.length}. Здесь публикуются итоги рассмотренных предложений — без имён авторов и конфиденциальных сведений.`)),
    h('div', { class: 'page-head' }, h('h2', null, 'Реализованные улучшения')),
    implemented.length === 0
      ? h('div', { class: 'card empty' }, 'Пока нет реализованных улучшений')
      : h('div', { class: 'board-grid' }, implemented.map((w) => h('article', { class: 'win' },
        h('div', { class: 'row' }, h('span', { class: 't-code' }, w.code), h('span', { class: 'chip' }, w.category)),
        h('b', null, w.title),
        h('div', { class: 'text-block muted' }, w.reportDone ?? w.resolution),
        w.reportEffect && h('div', { class: 'win-effect' }, h('b', null, 'Эффект: '), w.reportEffect),
        h('div', { class: 't-sub' }, `Завершено ${fmtDate(w.resolvedAt)}`)))),
    topAuthors.length > 0 && h('section', { class: 'card recognition' },
      h('h3', null, 'Авторы принятых идей'),
      authorOfMonth && h('div', { class: 'callout' }, h('b', null, 'Автор месяца: '), `${authorOfMonth.name} — принято идей: ${authorOfMonth.count}`),
      h('ul', { class: 'list-plain' }, topAuthors.map((a) => h('li', { class: 'row home-between' },
        h('span', null, h('b', null, a.name), ` · ${a.department}`), h('span', { class: 'chip' }, `принято: ${a.count}`)))),
      h('p', { class: 't-sub' }, 'Анонимные обращения в рейтинге не участвуют.')),
    h('div', { class: 'page-head', style: { marginTop: '32px' } },
      h('div', null, h('h2', null, 'Открытые идеи — проголосуйте'),
        h('p', null, 'Идеи коллег по числу голосов. Чем больше голосов, тем выше идея в повестке руководителей.'))),
    h('div', { class: 'card' }, h('ul', { class: 'list-plain' }, openIdeas.map((i) =>
      h('li', { class: 'row', style: { justifyContent: 'space-between' } },
        h('div', null, h('span', { class: 't-code' }, i.code), ' ', h('b', null, i.title),
          h('div', { class: 't-sub' }, `${i.category} · ${i.statusLabel} · голосов ${i.votesCount}`)),
        h('a', { class: 'btn btn-sm', href: `#/t/${i.id}` }, 'Проголосовать'))))));
}
