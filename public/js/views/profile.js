// «Мой профиль»: сотрудник сам указывает рабочую почту и телефон и решает, получать ли письма.
// Должность и подразделение меняет администратор или загрузка оргструктуры из Битрикс24.
import { h, mount, toast, field } from '../dom.js';
import { get, patch, post } from '../api.js';
import { pushSupported, currentPushSubscription, subscribePush, unsubscribePush } from '../pwa.js';
import { t } from '../i18n.js';

export async function renderProfile(el, { me }) {
  const profile = await get('/me');
  const emailIn = h('input', { type: 'email', value: profile.email ?? '', maxlength: 120, autocomplete: 'email' });
  const phoneIn = h('input', { type: 'tel', value: profile.phone ?? '', maxlength: 30, autocomplete: 'tel' });
  const mailToggle = h('input', { type: 'checkbox', checked: profile.emailNotify, disabled: !profile.email });

  const saveContacts = async (e) => {
    e.preventDefault();
    try {
      const saved = await patch('/me/contacts', { email: emailIn.value, phone: phoneIn.value });
      Object.assign(me, saved);
      mailToggle.disabled = !saved.email;
      toast('Контакты сохранены', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  mailToggle.onchange = async () => {
    try {
      await patch('/me/notifications', { email: mailToggle.checked });
      me.emailNotify = mailToggle.checked;
      toast(mailToggle.checked ? 'Уведомления будут приходить и на почту' : 'Письма отключены', 'success');
    } catch (error) {
      mailToggle.checked = !mailToggle.checked;
      toast(error.message, 'error');
    }
  };

  const fact = (k, v) => [h('dt', null, k), h('dd', null, v || '—')];

  // Push на этом устройстве: телефон или компьютер показывает уведомление, даже когда сайт закрыт.
  const pushStatus = h('p', { class: 't-sub', role: 'status' });
  const pushBtn = h('button', { class: 'btn', type: 'button' });
  const showPush = async () => {
    if (!pushSupported()) {
      pushStatus.textContent = t('Этот браузер не поддерживает push-уведомления или сайт открыт не по HTTPS.');
      pushBtn.hidden = true;
      return;
    }
    const subscribed = Boolean(await currentPushSubscription().catch(() => null));
    pushStatus.textContent = subscribed ? t('Включены на этом устройстве.') : t('Выключены на этом устройстве.');
    pushBtn.textContent = subscribed ? t('Отключить на этом устройстве') : t('Включить на этом устройстве');
    pushBtn.onclick = async () => {
      pushBtn.disabled = true;
      try {
        if (subscribed) {
          const endpoint = await unsubscribePush();
          if (endpoint) await post('/me/push/remove', { endpoint });
          toast('Push-уведомления на этом устройстве отключены', 'success');
        } else {
          const { publicKey } = await get('/push/key');
          await post('/me/push', await subscribePush(publicKey));
          toast('Push-уведомления на этом устройстве включены', 'success');
        }
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        pushBtn.disabled = false;
        showPush();
      }
    };
  };
  showPush();
  mount(el,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Мой профиль'),
      h('p', null, 'Рабочие контакты видят коллеги в карточке обращения, где вы ответственный. Личные данные указывать не нужно.'))),
    h('div', { class: 'an-grid admin-pair' },
      h('section', { class: 'card' },
        h('h3', null, me.name),
        h('dl', { class: 'facts' },
          fact('Роль', me.roleLabel),
          fact('Подразделение', me.department),
          fact('Должность', profile.position)),
        h('p', { class: 't-sub' }, 'Должность и подразделение меняет администратор или загрузка оргструктуры из Битрикс24.')),
      h('section', { class: 'card' },
        h('h3', null, 'Рабочие контакты'),
        h('form', { class: 'stack', onsubmit: saveContacts },
          field('Рабочая почта', emailIn, 'На неё приходят копии уведомлений, если письма включены.'),
          field('Рабочий телефон', phoneIn),
          h('p', { class: 't-sub' }, 'Если компания ведёт контакты в Битрикс24, при загрузке оргструктуры они обновятся оттуда.'),
          h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить контакты'))),
        h('label', { class: 'check', style: { marginTop: '16px' } }, mailToggle,
          h('span', null, 'Дублировать уведомления на почту',
            !profile.email && h('span', { class: 't-sub' }, ` — ${t('сначала укажите почту')}`))),
        h('h3', { style: { marginTop: '20px' } }, 'Push-уведомления'),
        h('p', { class: 't-sub' }, 'Уведомление приходит на телефон или компьютер, даже когда сайт закрыт. Включается отдельно на каждом устройстве.'),
        pushStatus, h('div', null, pushBtn))));
}
