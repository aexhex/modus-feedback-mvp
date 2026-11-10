import { h, mount, toast, debounce, field, options, fileToBase64 } from '../dom.js';
import { get, post, qs } from '../api.js';

const TYPE_HINTS = {
  problem: 'Что-то мешает работать: процесс, данные, взаимодействие',
  idea: 'Есть идея, как сделать лучше',
  praise: 'Хочу отметить то, что хорошо работает',
};
const MIN_SIMILAR_QUERY = 15;

function similarPanel() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Начните описывать ситуацию — мы покажем похожие обращения коллег. Если ваша тема уже есть, просто поддержите её.'));
  const update = async (text) => {
    if (text.trim().length < MIN_SIMILAR_QUERY) return;
    const items = await get(`/tickets/similar${qs({ text })}`);
    if (items.length === 0) {
      mount(body, h('p', { class: 'muted' }, 'Похожих обращений не найдено — ваша тема новая.'));
      return;
    }
    mount(body, items.map((s) => {
      const supportBtn = h('button', { class: 'btn btn-sm', onclick: async () => {
        try {
          const { supportsCount } = await post(`/tickets/${s.id}/support`);
          supportBtn.replaceWith(h('span', { class: 'chip' }, `✓ Вы поддержали · ${supportsCount}`));
        } catch (e) { toast(e.message, 'error'); }
      } }, '+ Поддержать');
      return h('div', { class: 'similar-item' },
        h('div', { class: 'row' }, h('span', { class: 't-code' }, s.code), h('span', { class: `badge status-${s.status}` }, s.statusLabel), h('span', { class: 'score' }, `сходство ${Math.round(s.score * 100)}%`)),
        h('div', { class: 't-title' }, s.title),
        h('div', { class: 't-sub' }, `${s.category} · поддержали: ${s.supportsCount}`),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          s.isOwn ? h('span', { class: 'chip' }, 'Ваше обращение') : supportBtn,
          s.canOpen && h('a', { class: 'btn btn-sm btn-ghost', href: `#/t/${s.id}` }, 'Открыть')));
    }));
  };
  return { el: h('aside', { class: 'card sticky' }, h('h3', null, 'Похожие обращения'), body), update };
}

async function uploadFiles(ticketId, files) {
  for (const file of files) {
    const dataBase64 = await fileToBase64(file);
    await post(`/tickets/${ticketId}/attachments`, { name: file.name, dataBase64 });
  }
}

export function renderNew(el, { meta, go }) {
  let type = 'problem';
  const similar = similarPanel();
  const titleIn = h('input', { type: 'text', maxlength: 150, placeholder: 'Например: в заявках не хватает параметров оборудования', required: true });
  const descIn = h('textarea', { rows: 6, maxlength: 5000, placeholder: 'Что происходит, где и как часто? Как это влияет на работу?', required: true });
  const solutionIn = h('textarea', { rows: 3, maxlength: 3000, placeholder: 'Если есть идея решения — опишите её (необязательно)' });
  const categoryIn = h('select', { required: true }, options(meta.categories, { valueKey: 'id', labelKey: 'name', empty: 'Выберите категорию' }));
  const priorityIn = h('select', { value: 'medium' }, options(meta.priorities));
  const anonIn = h('input', { type: 'checkbox' });
  const filesIn = h('input', { type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx,.csv' });
  const solutionField = field('Предлагаемое решение', solutionIn);
  const submitBtn = h('button', { class: 'btn btn-signal', type: 'submit' }, 'Отправить обращение');

  const refreshSimilar = debounce(() => similar.update(`${titleIn.value} ${descIn.value}`).catch(() => null), 450);
  titleIn.addEventListener('input', refreshSimilar);
  descIn.addEventListener('input', refreshSimilar);

  const typeCards = h('div', { class: 'type-cards', role: 'radiogroup', 'aria-label': 'Тип обращения' },
    meta.types.map((t) => {
      const card = h('label', { class: `type-card ${t.key === type ? 'selected' : ''}` },
        h('input', { type: 'radio', name: 'type', value: t.key, checked: t.key === type, onchange: () => {
          type = t.key;
          typeCards.querySelectorAll('.type-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          solutionField.hidden = type === 'praise';
          if (type === 'praise') priorityIn.value = 'low';
        } }),
        h('b', null, t.label), h('span', null, TYPE_HINTS[t.key]));
      return card;
    }));

  const onSubmit = async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      const ticket = await post('/tickets', {
        type,
        categoryId: Number(categoryIn.value),
        title: titleIn.value,
        description: descIn.value,
        proposedSolution: type === 'praise' ? '' : solutionIn.value,
        priority: priorityIn.value,
        isAnonymous: anonIn.checked,
      });
      await uploadFiles(ticket.id, [...filesIn.files]).catch((err) => toast(`Обращение создано, но файл не загружен: ${err.message}`, 'error'));
      toast(`Обращение ${ticket.code} зарегистрировано. Ответственный: ${ticket.assignee?.name ?? 'будет назначен'}`, 'success');
      go(`#/t/${ticket.id}`);
    } catch (err) {
      toast(err.message, 'error');
      submitBtn.disabled = false;
    }
  };

  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Новое обращение'),
        h('p', null, 'Обращение автоматически попадёт к ответственному по категории. Вы будете видеть статус и получите уведомление о результате.'))),
    h('div', { class: 'grid-2' },
      h('form', { class: 'card stack', onsubmit: onSubmit },
        typeCards,
        field('Категория', categoryIn, 'По категории определяется ответственный'),
        field('Кратко, о чём обращение', titleIn),
        field('Описание', descIn),
        solutionField,
        field('Насколько срочно', priorityIn, 'Определяет срок первого ответа: высокий — 1 день, средний — 3, низкий — 5'),
        field('Материалы', filesIn, 'PDF, изображения, txt, docx, xlsx, csv — до 5 МБ каждый'),
        h('label', { class: 'check anon-box' }, anonIn,
          h('span', null, h('b', null, 'Скрыть моё имя от обработчиков'),
            h('div', { class: 'field-hint' }, 'Вы по-прежнему видите статус и получаете ответы. Ответственный не увидит автора, но видит подразделение — уточнения возможны только через комментарии.'))),
        h('div', { class: 'row' }, submitBtn, h('a', { class: 'btn btn-ghost', href: '#/tickets?scope=mine' }, 'Отмена'))),
      similar.el));
}
