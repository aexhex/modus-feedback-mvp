// ДЕМО-ПОРТАЛ: имитация внешних систем для показа без доступа к настоящему Битрикс24 и 1С.
// Отвечает в тех же форматах, что REST Битрикс24 и OData 1С, поэтому система ходит к нему
// настоящими HTTP-запросами — тем же кодом, что и к боевому порталу. Включается только в демо-режиме.
// Данные синтетические и повторяют демо-датасет с несколькими отличиями, чтобы синхронизация
// показала новых, переведённых и уволенных сотрудников.
import { USERS } from '../seed-data.js';

const PAGE = 50;
const CALLS_KEPT = 100; // журнал вызовов демо-портала ограничен: портал открыт без входа

const HEADS = Object.freeze({
  Закупки: 'Руководитель закупок',
  'Дирекция направлений': 'Руководитель направления',
  'Каталог и НСИ': 'Ответственный за номенклатуру',
  HR: 'HR / внутренние коммуникации',
  Бухгалтерия: 'Руководитель бухгалтерии',
  'Офис процессов': 'Ответственный за процессы',
  IT: 'IT-специалист',
  'Юридический отдел': 'Ответственный за договоры',
  Продажи: 'Руководитель продаж',
  'Проектный офис': 'Руководитель проектов',
  Проектирование: 'Руководитель проектирования',
  'Административный отдел': 'Административный руководитель',
  Дирекция: 'Директор по развитию',
  Сервис: 'Руководитель сервиса',
});

// Отличия портала от демо-датасета системы.
const MOVED = Object.freeze({ 'Координатор проекта': 'Проектирование' });
const DISMISSED = Object.freeze(['Руководитель проекта']);
export const DEMO_HIRED = Object.freeze([['Руководитель сервиса', 'Сервис'], ['Инженер сервиса', 'Сервис'], ['Специалист по закупкам', 'Закупки']]);

export const DEMO_COUNTERPARTIES = Object.freeze([
  ['ТОО «Альфа Монтаж»', '000000101', '060140001234'],
  ['ТОО «СтройТехСервис»', '000000102', '110540005678'],
  ['АО «Северный терминал»', '000000103', '980240009012'],
  ['ТОО «Безопасный город»', '000000104', '150340003456'],
  ['ТОО «ПромСклад Логистик»', '000000105', '170940007890'],
  ['ГКП «Городская поликлиника №3»', '000000106', '010140002345'],
  ['ТОО «Энергоаудит»', '000000107', '190640006789'],
  ['ТОО «Старый партнёр» (помечен на удаление)', '000000108', '050140000001'],
]);

function buildData() {
  const people = [
    ...USERS.map(([name, , department]) => ({ name, department: MOVED[name] ?? department, active: !DISMISSED.includes(name) })),
    ...DEMO_HIRED.map(([name, department]) => ({ name, department, active: true })),
  ];
  const departments = [...new Set(people.map((p) => p.department))].map((name, i) => ({ ID: String(i + 1), NAME: name }));
  const deptId = new Map(departments.map((d) => [d.NAME, d.ID]));
  const users = people.map((p, i) => ({
    ID: String(101 + i), NAME: p.name, LAST_NAME: '', ACTIVE: p.active, UF_DEPARTMENT: [Number(deptId.get(p.department))],
  }));
  const userId = new Map(users.map((u) => [u.NAME, u.ID]));
  for (const d of departments) d.UF_HEAD = userId.get(HEADS[d.NAME]) ?? '';
  return { departments, users };
}

/** @returns {{ handle: (req, res, path: string, body: object) => void, calls: object[] }} */
export function createDemoPortal() {
  const { departments, users } = buildData();
  const calls = [];
  let nextTaskId = 2400;
  let nextMessageId = 0;
  const tasks = new Map(); // номер задачи → статус (коды REST Битрикс24)

  const page = (list, start) => {
    const from = Number(start) || 0;
    const result = list.slice(from, from + PAGE);
    return { result, total: list.length, ...(from + PAGE < list.length ? { next: from + PAGE } : {}) };
  };

  const b24 = {
    'department.get': () => page(departments, 0),
    'user.get': (p) => page(users, p.start),
    'im.notify': (p) => {
      // Как настоящий портал: неизвестному или отключённому получателю — result: false без ошибки.
      if (!users.some((u) => u.ID === String(p.USER_ID) && u.ACTIVE)) return { result: false };
      nextMessageId += 1;
      return { result: nextMessageId };
    },
    'tasks.task.add': (p) => {
      if (!p.fields?.TITLE) return { error: 'ERROR_CORE', error_description: 'Не указано название задачи' };
      nextTaskId += 1;
      tasks.set(String(nextTaskId), '2');
      return { result: { task: { id: String(nextTaskId), title: p.fields.TITLE } } };
    },
    'tasks.task.get': (p) => (tasks.has(String(p.taskId))
      ? { result: { task: { id: String(p.taskId), status: tasks.get(String(p.taskId)) } } }
      : { error: 'ERROR_CORE', error_description: 'Задача не найдена или доступ запрещён' }),
    'tasks.task.complete': (p) => {
      if (!tasks.has(String(p.taskId))) return { error: 'ERROR_CORE', error_description: 'Задача не найдена или доступ запрещён' };
      tasks.set(String(p.taskId), '5');
      return { result: { task: { id: String(p.taskId), status: '5' } } };
    },
  };

  const record = (call) => {
    calls.push(call);
    if (calls.length > CALLS_KEPT) calls.splice(0, calls.length - CALLS_KEPT);
  };

  function handle(req, res, path, params) {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    const b24Match = /^\/b24\/rest\/1\/demo\/([a-z.]+)\.json$/.exec(path);
    if (b24Match) {
      const method = b24[b24Match[1]];
      if (!method) return send(404, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Метод не найден' });
      record({ system: 'b24', method: b24Match[1], params });
      return send(200, method(params));
    }
    if (decodeURIComponent(path) === '/1c/odata/standard.odata/Catalog_Контрагенты') {
      record({ system: '1c', method: 'Catalog_Контрагенты' });
      return send(200, {
        value: DEMO_COUNTERPARTIES.map(([name, code, inn], i) => ({
          Ref_Key: `5f0c6a1e-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          Code: code, Description: name, ИНН: inn, DeletionMark: name.includes('удаление'),
        })),
      });
    }
    return send(404, { error: 'NOT_FOUND' });
  }

  return { handle, calls };
}
