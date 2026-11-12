import { h, mount, toast, debounce, field, options, fileToBase64, filePicker, compressPhoto } from '../dom.js';
import { get, post, qs } from '../api.js';
import { t } from '../i18n.js';

const TYPE_HINTS = {
  problem: 'Что-то мешает работать: процесс, данные, взаимодействие',
  idea: 'Есть идея, как сделать лучше',
  praise: 'Хочу отметить то, что хорошо работает',
};
const MIN_SIMILAR_QUERY = 15;

function similarPanel() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Начните описывать ситуацию — мы покажем похожие обращения коллег. Если такая проблема уже есть, нажмите «У меня тоже»; за похожую идею проголосуйте.'));
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
          supportBtn.replaceWith(h('span', { class: 'chip' }, `✓ Отмечено · у ${supportsCount} так же`));
        } catch (e) { toast(e.message, 'error'); }
      } }, 'У меня тоже');
      return h('div', { class: 'similar-item' },
        h('div', { class: 'row' }, h('span', { class: 't-code' }, s.code), h('span', { class: `badge status-${s.status}` }, s.statusLabel), h('span', { class: 'score' }, `сходство ${Math.round(s.score * 100)}%`)),
        h('div', { class: 't-title' }, s.title),
        h('div', { class: 't-sub' }, s.type === 'idea' ? s.category : `${s.category} · у кого так же: ${s.supportsCount}`),
        // Вопрос уже рассмотрен — показываем итог, чтобы не подавать то же самое заново.
        s.resolution && h('div', { class: `already-solved ${s.status === 'rejected' ? 'rejected' : ''}` },
          h('b', null, s.status === 'rejected' ? 'Уже рассматривали, отказ: ' : 'Уже решено: '), s.resolution),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          s.isOwn ? h('span', { class: 'chip' }, 'Ваше обращение')
            : s.type === 'problem' ? supportBtn
              : s.canOpen && h('a', { class: 'btn btn-sm', href: `#/t/${s.id}` }, 'Проголосовать'),
          s.canOpen && h('a', { class: 'btn btn-sm btn-ghost', href: `#/t/${s.id}` }, 'Открыть')));
    }));
  };
  return { el: h('aside', { class: 'card sticky' }, h('h3', null, 'Похожие обращения'), body), update };
}

async function uploadFiles(ticketId, files, photos) {
  for (const file of files) {
    const dataBase64 = await fileToBase64(file);
    await post(`/tickets/${ticketId}/attachments`, { name: file.name, dataBase64 });
  }
  for (const photo of photos) {
    await post(`/tickets/${ticketId}/attachments`, { name: photo.name, dataBase64: photo.dataBase64 });
  }
}

// Фото с камеры телефона (на компьютере — выбор изображения): сжимается и показывается миниатюрой.
function photoPicker() {
  const photos = [];
  const thumbs = h('div', { class: 'photo-thumbs' });
  const redraw = () => thumbs.replaceChildren(...photos.map((p, i) => h('figure', { class: 'photo-thumb' },
    h('img', { src: p.dataUrl, alt: `Фото ${i + 1}` }),
    h('button', { type: 'button', class: 'photo-remove', 'aria-label': `Убрать фото ${i + 1}`, onclick: () => { photos.splice(i, 1); redraw(); } }, '×'))));
  let pending = Promise.resolve();
  const processFiles = async (files) => {
    for (const file of files) {
      try {
        const { dataUrl, dataBase64 } = await compressPhoto(file);
        photos.push({ name: `photo-${Date.now()}-${photos.length + 1}.jpg`, dataUrl, dataBase64 });
      } catch {
        toast(`Не удалось обработать фото ${file.name}`, 'error');
      }
    }
    redraw();
  };
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', onchange: () => {
    const files = [...input.files];
    input.value = '';
    pending = pending.then(() => processFiles(files));
  } });
  const el = h('div', { class: 'photo-pick' },
    h('label', { class: 'btn btn-sm photo-btn' }, input, '📷 Сделать фото'), thumbs);
  return { el, photos, ready: () => pending };
}

export function renderNew(el, { me, meta, go, rerender }) {
  let type = 'problem';
  let submitted = false;
  const draftKey = `draft:${me.id}`;
  const similar = similarPanel();
  const titleIn = h('input', { type: 'text', maxlength: 150, placeholder: 'Например: в заявках не хватает параметров оборудования', required: true });
  const descIn = h('textarea', { rows: 6, maxlength: 5000, placeholder: 'Что происходит, где и как часто? Как это влияет на работу?', required: true });
  const solutionIn = h('textarea', { rows: 3, maxlength: 3000, placeholder: 'Если есть идея решения — опишите её (необязательно)' });
  const categoryIn = h('select', { required: true }, options(meta.categories, { valueKey: 'id', labelKey: 'name', empty: 'Выберите категорию' }));
  const priorityIn = h('select', { value: 'medium' }, options(meta.priorities));
  // Клиент из справочника 1С УТ — поле появляется, когда справочник загружен администратором.
  // Названия клиентов — данные 1С, их не переводим.
  const clientIn = h('select', { 'data-no-i18n': '' }, h('option', { value: '' }, t('— не связано с клиентом —')));
  // Клиент из черновика: список загружается асинхронно, поэтому выбор восстанавливается после загрузки.
  let draftClient = '';
  if (meta.hasCounterparties) {
    get('/counterparties')
      .then((list) => {
        clientIn.append(...list.map((c) => h('option', { value: String(c.id) }, c.inn ? `${c.name} · ${c.inn}` : c.name)));
        if (draftClient) clientIn.value = draftClient;
      })
      .catch((err) => toast(err.message, 'error'));
  }
  const anonIn = h('input', { type: 'checkbox' });
  const publicIn = h('input', { type: 'checkbox' });
  const files = filePicker({ multiple: true });
  const camera = photoPicker();
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
          publicIn.checked = type === 'idea';
          if (type === 'praise') priorityIn.value = 'low';
        } }),
        h('b', null, t.label), h('span', null, TYPE_HINTS[t.key]));
      return card;
    }));

  const onSubmit = async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      await camera.ready();
      const ticket = await post('/tickets', {
        type,
        categoryId: Number(categoryIn.value),
        title: titleIn.value,
        description: descIn.value,
        proposedSolution: type === 'praise' ? '' : solutionIn.value,
        priority: priorityIn.value,
        isAnonymous: anonIn.checked,
        isPublic: publicIn.checked,
        counterpartyId: clientIn.value ? Number(clientIn.value) : null,
      });
      submitted = true;
      clearDraft();
      await uploadFiles(ticket.id, [...files.input.files], camera.photos).catch((err) => toast(`Обращение создано, но файл не загружен: ${err.message}`, 'error'));
      toast(`Обращение ${ticket.code} зарегистрировано. Ответственный: ${ticket.assignee?.name ?? 'будет назначен'}`, 'success');
      go(`#/t/${ticket.id}`);
    } catch (err) {
      toast(err.message, 'error');
      submitBtn.disabled = false;
    }
  };

  // Черновик хранится в браузере отдельно для каждого пользователя и удаляется после отправки.
  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // Хранилище недоступно — черновика и не было.
    }
  };
  // submitted также выставляется при очистке: отложенное сохранение не должно вернуть удалённый черновик.
  const saveDraft = debounce(() => {
    if (submitted) return;
    const draft = {
      type, categoryId: categoryIn.value, title: titleIn.value, description: descIn.value,
      solution: solutionIn.value, priority: priorityIn.value, anon: anonIn.checked, isPublic: publicIn.checked,
      counterpartyId: clientIn.value,
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Хранилище недоступно (приватный режим) — работаем без черновика.
    }
  }, 400);
  const applyDraft = () => {
    let draft = null;
    try {
      draft = JSON.parse(localStorage.getItem(draftKey));
    } catch {
      draft = null;
    }
    if (!draft || !(draft.title || draft.description || draft.solution)) return;
    if (meta.types.some((t) => t.key === draft.type)) typeCards.querySelector(`input[value="${draft.type}"]`).click();
    categoryIn.value = draft.categoryId ?? '';
    titleIn.value = draft.title ?? '';
    descIn.value = draft.description ?? '';
    solutionIn.value = draft.solution ?? '';
    if (meta.priorities.some((p) => p.key === draft.priority)) priorityIn.value = draft.priority;
    anonIn.checked = draft.anon === true;
    draftClient = typeof draft.counterpartyId === 'string' ? draft.counterpartyId : '';
    clientIn.value = draftClient;
    // Выбор типа выше включает публикацию для предложений; сохранённое решение автора важнее.
    if (typeof draft.isPublic === 'boolean') publicIn.checked = draft.isPublic;
    draftNote.hidden = false;
    refreshSimilar();
  };
  const draftNote = h('div', { class: 'callout row', hidden: true },
    h('span', null, 'Восстановлен несохранённый черновик.'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { submitted = true; clearDraft(); rerender(); } }, 'Очистить'));

  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Новое обращение'),
        h('p', null, 'Обращение автоматически попадёт к ответственному по категории. Вы будете видеть статус и получите уведомление о результате.'))),
    draftNote,
    h('div', { class: 'grid-2' },
      h('form', { class: 'card stack', onsubmit: onSubmit, oninput: saveDraft, onchange: saveDraft },
        typeCards,
        field('Категория', categoryIn, 'По категории определяется ответственный'),
        field('Кратко, о чём обращение', titleIn),
        field('Описание', descIn),
        solutionField,
        meta.hasCounterparties && field('Клиент', clientIn, 'Необязательно. Если проблема связана с конкретным клиентом — выберите его из справочника 1С УТ'),
        field('Насколько срочно', priorityIn, `Срок первого ответа в рабочих днях: ${meta.sla.map((s) => `${s.label.toLowerCase()} — ${s.firstResponseDays}`).join(', ')}`),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Материалы'),
          h('div', { class: 'row' }, camera.el, files.el),
          h('span', { class: 'field-hint' }, 'Фото с камеры сжимается автоматически. Файлы: PDF, изображения, txt, docx, xlsx, csv — до 5 МБ каждый')),
        h('label', { class: 'check anon-box' }, anonIn,
          h('span', null, h('b', null, 'Подать анонимно'),
            h('div', { class: 'field-hint' }, 'Ваше имя и подразделение скрыты от всех, включая руководителей. Вы по-прежнему видите статус, получаете ответы и можете отвечать на уточнения в комментариях.'))),
        h('label', { class: 'check anon-box' }, publicIn,
          h('span', null, h('b', null, 'Показать в «Идеях коллег»'),
            h('div', { class: 'field-hint' }, 'Обращение смогут читать, комментировать и поддерживать все сотрудники. Для предложений включается автоматически — снимите отметку, если тема не для всех.'))),
        h('div', { class: 'row' }, submitBtn, h('a', { class: 'btn btn-ghost', href: '#/tickets?scope=mine' }, 'Отмена'))),
      similar.el));
  applyDraft();
}
