// Вход в два шага: сначала роль (четыре крупные карточки), затем конкретный человек.
// Если в роли один пользователь, вход выполняется сразу — так демо проходит быстрее.
import { h, mount, toast, themeToggle } from '../dom.js';
import { get } from '../api.js';

const ROLE_INFO = {
  employee: {
    lead: 'Подаёт обращения и видит, что с ними происходит',
    points: ['Подача за минуту, подсказка похожих', 'Статус, сроки и ответ ответственного', 'Идеи коллег, голосование, опросы'],
  },
  handler: {
    lead: 'Рассматривает назначенные обращения',
    points: ['Очередь со сроками и просрочками', 'Уточнение у автора, шаблоны ответов', 'Канбан, отчёт о внедрении'],
  },
  manager: {
    lead: 'Контролирует сроки и результат',
    points: ['Показатели, графики, нагрузка', 'Сводка недели и отчёт за период', 'Отзывы клиентов и опросы'],
  },
  admin: {
    lead: 'Настраивает систему',
    points: ['Категории и маршрутизация', 'Пользователи, сроки, праздники', 'Журнал действий, сброс демо'],
  },
};

const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'пользователь'
  : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'пользователя' : 'пользователей');

function hero() {
  return h('div', { class: 'login-hero' },
    h('div', null,
      h('h3', null, 'ГК «Модус Трейд» · хакатон'),
      h('h1', null, 'Голос сотрудника: ', h('em', null, 'ни одно предложение'), ' не теряется')),
    h('p', { class: 'login-note' },
      'Демо-вход без пароля: выберите роль, чтобы пройти сценарий от её лица. ',
      'В промышленной версии вход — через корпоративную учётную запись (SSO Битрикс24). Все данные синтетические. ',
      h('a', { href: '#/client' }, 'Форма отзыва для клиентов →')));
}

export async function renderLogin(root, { onLogin }) {
  const { users, roles } = await get('/demo-users');
  const login = (id) => onLogin(id).catch((e) => toast(e.message, 'error'));
  const stage = h('div');

  const showUsers = (role) => {
    const list = users.filter((u) => u.role === role);
    mount(stage,
      h('div', { class: 'login-step-head' },
        h('button', { class: 'btn btn-ghost btn-sm', onclick: showRoles }, '← Другая роль'),
        h('h2', null, `Войти как: ${roles[role]}`)),
      h('div', { class: 'user-grid' }, list.map((u) => h('button', { class: 'user-card', onclick: () => login(u.id) },
        h('b', null, u.name), h('span', null, u.department)))));
    stage.querySelector('.user-card')?.focus();
  };

  function showRoles() {
    mount(stage, h('div', { class: 'role-cards' }, Object.keys(roles).map((role) => {
      const list = users.filter((u) => u.role === role);
      const info = ROLE_INFO[role];
      return h('button', {
        class: `role-card role-${role}`, 'data-role': role, disabled: list.length === 0,
        onclick: () => (list.length === 1 ? login(list[0].id) : showUsers(role)),
      },
      h('span', { class: 'role-card-name' }, roles[role]),
      h('span', { class: 'role-card-lead' }, info.lead),
      h('ul', null, info.points.map((p) => h('li', null, p))),
      h('span', { class: 'role-card-foot' }, list.length === 1 ? `Войти: ${list[0].name} →` : `${list.length} ${plural(list.length)} →`));
    })));
  }

  showRoles();
  mount(root, h('div', { class: 'login' }, h('div', { class: 'login-top' }, themeToggle()), hero(), stage));
}
