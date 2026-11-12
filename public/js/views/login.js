// Вход в два шага: сначала роль (четыре крупные карточки), затем конкретный человек.
// Если в роли один пользователь, вход выполняется сразу — так демо проходит быстрее.
import { h, svg, mount, toast, themeToggle } from '../dom.js';
import { langSwitch } from '../i18n.js';
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

// Ответ сервера после возврата с портала Битрикс24 (/?login_error=...).
const LOGIN_ERRORS = {
  not_linked: 'Ваша учётная запись Битрикс24 не связана с сотрудником в системе. Обратитесь к администратору: он загружает оргструктуру из Битрикс24.',
  inactive: 'Ваша учётная запись Битрикс24 отключена. Если это ошибка, обратитесь к администратору портала.',
  denied: 'Вход через Битрикс24 отменён.',
  state: 'Вход через Битрикс24 устарел или открыт в другом браузере. Попробуйте ещё раз.',
  failed: 'Не удалось связаться с Битрикс24. Попробуйте ещё раз через минуту.',
};

function takeLoginError() {
  const params = new URLSearchParams(location.search);
  const code = params.get('login_error');
  if (!code) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  return LOGIN_ERRORS[code] ?? LOGIN_ERRORS.failed;
}

function b24Login(options, error) {
  // Рабочая установка без входа через портал и без явного разрешения входа из списка: войти нельзя никак.
  if (!options.b24 && !options.list) {
    return h('p', { class: 'login-error', role: 'alert' },
      'Вход не настроен. Администратору: подключите вход через Битрикс24 (B24_CLIENT_ID) или, только во внутренней сети, разрешите вход выбором из списка (ALLOW_LIST_LOGIN=1).');
  }
  if (!options.b24) return null;
  return h('div', { class: 'b24-login' },
    error ? h('p', { class: 'login-error', role: 'alert' }, error) : null,
    h('a', { class: 'btn btn-primary', href: '/api/auth/b24/start' }, 'Войти через Битрикс24'),
    h('p', { class: 'muted' }, options.list
      ? 'Как в рабочей установке: вход учётной записью портала. В демо — через встроенный демо-портал, после загрузки оргструктуры в «Настройках».'
      : 'Вход учётной записью вашего портала Битрикс24. Пароль вводится на портале, система его не видит.'));
}

// Полный логотип ГК «Модус Трейд»: знак и надпись. Кольцо и буквы — цветом текста логотипа
// (тёмно-синий в светлой теме, белый в тёмной), красный круг — фирменный.
function brandLogo() {
  const mark = svg('svg', { class: 'brand-logo-mark', viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    svg('path', { fill: 'currentColor', d: 'M4.7 42A46 46 0 0 1 95.3 42H80A31 31 0 0 0 20 42Z' }),
    svg('path', { fill: 'currentColor', d: 'M4.7 58A46 46 0 0 0 95.3 58H80A31 31 0 0 1 20 58Z' }),
    svg('circle', { cx: 50, cy: 50.5, r: 17.5, fill: '#ed1111' }),
    svg('circle', { cx: 56.3, cy: 44.6, r: 5.4, fill: '#fff' }));
  return h('div', { class: 'brand-logo', role: 'img', 'aria-label': 'ГК «Модус Трейд»' },
    mark, h('span', { class: 'brand-logo-text', 'aria-hidden': 'true' }, h('span', null, 'МОДУС'), h('span', null, 'ТРЕЙД')));
}

function hero(options) {
  return h('div', { class: 'login-hero' },
    h('div', null,
      h('h3', null, 'ГК «Модус Трейд» · хакатон'),
      h('h1', null, 'Голос сотрудника: ', h('em', null, 'ни одно предложение'), ' не теряется')),
    options.list
      ? h('p', { class: 'login-note' },
        'Демо-вход без пароля: выберите роль, чтобы пройти сценарий от её лица. Все данные синтетические. ',
        h('a', { href: '#/client' }, 'Форма отзыва для клиентов →'))
      : h('p', { class: 'login-note' }, h('a', { href: '#/client' }, 'Форма отзыва для клиентов →')));
}

export async function renderLogin(root, { onLogin }) {
  const options = await get('/auth/options');
  const error = takeLoginError();
  const top = h('div', { class: 'login-top' }, brandLogo(), h('div', { class: 'login-top-tools' }, langSwitch(), themeToggle()));
  if (!options.list) {
    mount(root, h('div', { class: 'login' }, top, hero(options), b24Login(options, error ?? null)));
    return;
  }
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
  mount(root, h('div', { class: 'login' }, top, hero(options), b24Login(options, error), stage));
}
