// Главная: для каждой роли — то, что требует внимания прямо сейчас.
import { h, mount, badge, slaChip, fmtDate } from '../dom.js';
import { get } from '../api.js';
import { weeklyFlowChart } from '../chart.js';

const ticketLine = (t) => h('li', null,
  h('a', { class: 'home-ticket', href: `#/t/${t.id}` },
    h('span', { class: 't-code' }, t.code), h('span', { class: 'home-ticket-title' }, t.title)),
  h('div', { class: 'row home-ticket-meta' }, badge('status', t.status, t.statusLabel), slaChip(t)));

const ticketList = (items, empty) => (items.length === 0
  ? h('p', { class: 'muted' }, empty)
  : h('ul', { class: 'list-plain' }, items.map(ticketLine)));

const tile = (value, label, { alert = false, href } = {}) =>
  h(href ? 'a' : 'div', { class: `kpi ${alert ? 'alert' : ''} ${href ? 'kpi-link' : ''}`, href },
    h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-label' }, label));

const card = (title, ...body) => h('section', { class: 'card' }, h('h3', null, title), body);

function oversightBlock(o) {
  const k = o.kpi;
  return [
    h('div', { class: 'kpis' },
      tile(String(o.total), 'Всего обращений', { href: '#/tickets?scope=all' }),
      tile(String(k.overdueCount), 'Просрочено по SLA', { alert: k.overdueCount > 0, href: '#/tickets?scope=all&overdue=1' }),
      tile(k.avgFirstResponseHours === null ? '—' : `${k.avgFirstResponseHours} ч`, 'До первого ответа в среднем'),
      tile(String(k.implementedCount), 'Реализовано улучшений', { href: '#/board' }),
      tile(String(o.unassigned), 'Без ответственного', { alert: o.unassigned > 0 })),
    h('div', { class: 'home-grid' },
      h('section', { class: 'card home-wide' }, weeklyFlowChart(o.weekly)),
      card('Просрочены — нужна ваша реакция',
        o.overdue.length === 0 ? h('p', { class: 'muted' }, 'Просрочек нет') : h('ul', { class: 'list-plain' }, o.overdue.map((t) =>
          h('li', null, h('a', { class: 'home-ticket', href: `#/t/${t.id}` }, h('span', { class: 't-code' }, t.code), h('span', { class: 'home-ticket-title' }, t.title)),
            h('div', { class: 't-sub' }, `${t.kind === 'first_response' ? 'Нет первого ответа' : 'Истёк срок решения'} · ${t.assignee ?? 'без ответственного'}`))))),
      card('Повторяющиеся темы',
        h('ul', { class: 'list-plain' }, o.repeatedTopics.map((t) =>
          h('li', { class: 'row home-between' }, h('b', null, t.category),
            h('span', { class: 't-sub' }, `обращений ${t.count} · поддержек ${t.supports}`)))),
        h('a', { class: 'btn btn-sm home-more', href: '#/analytics' }, 'Вся аналитика'))),
  ];
}

function handlerBlock(q) {
  return [
    h('div', { class: 'kpis' },
      tile(String(q.openCount), 'В вашей очереди', { href: '#/tickets?scope=assigned' }),
      tile(String(q.waitingFirstResponse.length), 'Ждут первого ответа'),
      tile(String(q.overdueCount), 'Просрочено', { alert: q.overdueCount > 0, href: '#/tickets?scope=assigned&overdue=1' })),
    h('div', { class: 'home-grid' },
      card('Ждут первого ответа', ticketList(q.waitingFirstResponse, 'Все новые обращения получили ответ')),
      card('Ближайшие сроки решения', ticketList(q.nextDeadlines, 'Обращений в работе нет'),
        h('a', { class: 'btn btn-sm home-more', href: '#/kanban' }, 'Открыть доску задач'))),
  ];
}

function authorBlock(a, wins) {
  return h('div', { class: 'home-grid' },
    card('Мои обращения',
      a.myTotal === 0
        ? h('p', { class: 'muted' }, 'Вы ещё ничего не отправляли. Заметили проблему или есть идея — расскажите.')
        : [h('div', { class: 'row home-chips' }, a.myByStatus.map((s) => h('span', { class: `badge status-${s.key}` }, `${s.label}: ${s.count}`))),
          ticketList(a.myRecent, '')],
      a.implementedCount > 0 && h('p', { class: 'home-accepted' }, `Принято ваших идей: ${a.implementedCount}`),
      h('a', { class: 'btn btn-sm home-more', href: '#/tickets?scope=mine' }, 'Все мои обращения')),
    card('Недавно реализовано',
      wins.length === 0 ? h('p', { class: 'muted' }, 'Пока нет реализованных улучшений')
        : h('ul', { class: 'list-plain' }, wins.map((w) => h('li', null,
          h('b', null, w.title), h('div', { class: 't-sub' }, `${w.category} · ${fmtDate(w.resolvedAt)}`),
          h('div', { class: 'muted' }, w.resolution)))),
      h('a', { class: 'btn btn-sm home-more', href: '#/board' }, 'Доска улучшений')));
}

export async function renderHome(el, { me }) {
  const home = await get('/home');
  const needsReply = home.author.needsReply;
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, `Здравствуйте, ${me.name}`), h('p', null, `${me.roleLabel} · ${me.department}`)),
      h('a', { class: 'btn btn-signal', href: '#/new' }, '+ Новое обращение')),
    home.surveysOpen > 0 && h('a', { class: 'callout home-callout home-survey', href: '#/surveys' },
      `Вас ждёт опрос (${home.surveysOpen}) — это займёт пару минут →`),
    needsReply.length > 0 && h('section', { class: 'callout home-callout' },
      h('b', null, `Ответственный ждёт вашего уточнения: ${needsReply.length}`),
      h('ul', { class: 'list-plain' }, needsReply.map(ticketLine))),
    home.oversight && oversightBlock(home.oversight),
    home.handler && handlerBlock(home.handler),
    authorBlock(home.author, home.wins));
}
