import { h, mount, toast } from '../dom.js';
import { get } from '../api.js';

const ROLE_HINTS = {
  employee: 'Подаёт обращения, следит за статусом, отвечает на уточнения',
  handler: 'Рассматривает назначенные обращения и фиксирует результат',
  manager: 'Видит все обращения, переназначает, следит за SLA и аналитикой',
  admin: 'Настраивает категории, маршрутизацию и доступность ответственных',
};

export async function renderLogin(root, { onLogin }) {
  const { users, roles } = await get('/demo-users');
  const groups = Object.keys(roles).map((role) => ({ role, users: users.filter((u) => u.role === role) }));
  mount(root,
    h('div', { class: 'login' },
      h('div', { class: 'login-hero' },
        h('div', null,
          h('h3', null, 'ГК «Модус Трейд» · хакатон'),
          h('h1', null, 'Голос сотрудника: ', h('em', null, 'ни одно предложение'), ' не теряется')),
        h('p', { class: 'login-note' },
          'Демо-вход без пароля: выберите роль, чтобы пройти сценарий от её лица. ',
          'В промышленной версии вход выполняется через корпоративную учётную запись (SSO Битрикс24). ',
          'Все данные синтетические. ',
          h('a', { href: '#/client' }, 'Форма отзыва для клиентов →'))),
      groups.map(({ role, users: list }) =>
        h('section', { class: 'role-group' },
          h('h3', null, `${roles[role]} — ${ROLE_HINTS[role]}`),
          h('div', { class: 'user-grid' },
            list.map((u) => h('button', {
              class: 'user-card',
              onclick: () => onLogin(u.id).catch((e) => toast(e.message, 'error')),
            }, h('b', null, u.name), h('span', null, u.department))))))));
}
