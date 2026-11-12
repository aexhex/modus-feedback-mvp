import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { evaluateTargets, TARGET_DEFS } from '../src/targets.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
const defaults = () => Object.fromEntries(TARGET_DEFS.map((d) => [d.key, d.default]));

describe('цели показателей (план / факт)', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('сравнивает факт с целью в нужную сторону', () => {
    const r = evaluateTargets({ reviewedShare: 95, avgFirstResponseHours: 30, overdueCount: 0, closedShare: null }, defaults());
    assert.equal(r.reviewedShare.met, true);
    assert.equal(r.avgFirstResponseHours.met, false);
    assert.equal(r.overdueCount.met, true);
    assert.equal(r.closedShare.met, null);
  });

  it('аналитика отдаёт цели по умолчанию с оценкой', async () => {
    const manager = await app.as('Директор по развитию');
    const { targets, kpi } = (await manager.get('/api/analytics')).json.data;
    assert.equal(targets.overdueCount.target, 0);
    assert.equal(targets.overdueCount.met, kpi.overdueCount <= 0);
    assert.equal(targets.reviewedShare.dir, 'min');
  });

  it('администратор меняет цели, изменение в журнале; неверные значения отклоняются', async () => {
    const admin = await app.as('Администратор системы');
    const r = await admin.patch('/api/admin/targets', { ...defaults(), overdueCount: 5, reviewedShare: 50 });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.find((t) => t.key === 'overdueCount').value, 5);
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.get('/api/analytics')).json.data.targets.overdueCount.target, 5);
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Цели показателей изменены'));

    assert.equal((await admin.patch('/api/admin/targets', { ...defaults(), reviewedShare: 120 })).status, 400);
    assert.equal((await admin.patch('/api/admin/targets', { ...defaults(), overdueCount: '' })).status, 400);
    assert.equal((await manager.patch('/api/admin/targets', defaults())).status, 403);
  });
});

describe('карта повторяющихся проблем', () => {
  it('строит матрицу категория × подразделение, сначала самые распространённые', async () => {
    const app = await startTestApp();
    try {
      const manager = await app.as('Директор по развитию');
      const { problemMap } = (await manager.get('/api/analytics')).json.data;
      assert.ok(problemMap.departments.length > 1);
      assert.ok(problemMap.categories.length > 0);
      for (const row of problemMap.categories) {
        assert.equal(row.cells.length, problemMap.departments.length);
        assert.equal(row.total, row.cells.reduce((a, b) => a + b, 0));
        assert.equal(row.spread, row.cells.filter(Boolean).length);
        assert.ok(row.total > 0);
      }
      const spreads = problemMap.categories.map((c) => c.spread);
      assert.deepEqual(spreads, [...spreads].sort((a, b) => b - a));
      assert.equal(problemMap.max, Math.max(...problemMap.categories.flatMap((c) => c.cells)));

      // Анонимное обращение не попадает в разрез по подразделениям: ячейка выдала бы отдел автора.
      const before = (await manager.get('/api/analytics')).json.data;
      const author = await app.as('Сотрудник бухгалтерии');
      await author.post('/api/tickets', {
        type: 'problem', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id, isAnonymous: true,
        title: 'Анонимная проблема для проверки карты', description: 'Описание анонимной проблемы для проверки карты.',
      });
      const after = (await manager.get('/api/analytics')).json.data;
      assert.equal(after.total, before.total + 1);
      assert.deepEqual(after.problemMap, before.problemMap);
      assert.deepEqual(after.byDepartment, before.byDepartment);
    } finally {
      await app.close();
    }
  });
});

describe('база решений и «Уже решено»', () => {
  let app;
  let privateId;
  before(async () => {
    app = await startTestApp();
    // Закрытая (не опубликованная) проблема с отказом: её итог видят только автор и обработчики.
    const author = await app.as('Сотрудник офиса');
    privateId = (await author.post('/api/tickets', {
      type: 'problem', categoryId: categoryId(app, 'Хранение документов'),
      title: 'Запираемый шкаф для архивных договоров', description: 'Нужен отдельный запираемый шкаф для архивных договоров.',
    })).json.data.id;
    const manager = await app.as('Директор по развитию');
    await manager.post(`/api/tickets/${privateId}/status`, { status: 'in_review', comment: 'Смотрим' });
    const r = await manager.post(`/api/tickets/${privateId}/status`, { status: 'rejected', resolution: 'Архив переезжает в электронный вид, шкаф не нужен.' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
  after(() => app.close());

  it('показывает реализованные улучшения всем, без авторов', async () => {
    const emp = await app.as('Менеджер по продажам');
    const list = (await emp.get('/api/solutions')).json.data;
    const codes = list.map((s) => s.code);
    assert.ok(codes.includes('A-004') && codes.includes('A-008'));
    assert.ok(!codes.includes('A-018'), 'положительные отзывы — не решения');
    const item = list.find((s) => s.code === 'A-004');
    assert.equal(item.outcome, 'implemented');
    assert.ok(item.resolution);
    assert.equal(item.author, undefined);
  });

  it('чужой закрытый отказ не виден постороннему, но виден автору и руководителю', async () => {
    const stranger = await app.as('Менеджер по продажам');
    assert.ok(!(await stranger.get('/api/solutions')).json.data.some((s) => s.id === privateId));
    const author = await app.as('Сотрудник офиса');
    const own = (await author.get('/api/solutions')).json.data.find((s) => s.id === privateId);
    assert.equal(own.outcome, 'rejected');
    assert.equal(own.canOpen, true);
    const manager = await app.as('Директор по развитию');
    assert.ok((await manager.get('/api/solutions?outcome=rejected')).json.data.some((s) => s.id === privateId));
  });

  it('фильтрует по тексту, категории и итогу', async () => {
    const manager = await app.as('Директор по развитию');
    const byText = (await manager.get(`/api/solutions?q=${encodeURIComponent('ЭЛЕКТРОННЫЙ вид')}`)).json.data;
    assert.deepEqual(byText.map((s) => s.id), [privateId]);
    const byCategory = (await manager.get(`/api/solutions?category=${categoryId(app, 'Обучение')}`)).json.data;
    assert.ok(byCategory.length > 0 && byCategory.every((s) => s.category.name === 'Обучение'));
    const implemented = (await manager.get('/api/solutions?outcome=implemented')).json.data;
    assert.ok(implemented.length > 0 && implemented.every((s) => s.outcome === 'implemented'));
  });

  it('подсказка похожих показывает итог только тем, кто может его видеть', async () => {
    const text = encodeURIComponent('нужен запираемый шкаф для архивных договоров');
    const author = await app.as('Сотрудник офиса');
    const mine = (await author.get(`/api/tickets/similar?text=${text}`)).json.data.find((s) => s.id === privateId);
    assert.match(mine.resolution, /электронный вид/);
    const stranger = await app.as('Менеджер по продажам');
    const theirs = (await stranger.get(`/api/tickets/similar?text=${text}`)).json.data.find((s) => s.id === privateId);
    assert.equal(theirs.resolution, null);

    const implementedText = encodeURIComponent('обучающие занятия по новым товарным линейкам');
    const a004 = (await stranger.get(`/api/tickets/similar?text=${implementedText}`)).json.data.find((s) => s.code === 'A-004');
    assert.ok(a004?.resolution, 'итог реализованного улучшения публичен');
  });

  it('чужое закрытое: текст не подбирается, тема анонимного скрыта, номера не перебираются', async () => {
    const author = await app.as('Сотрудник офиса');
    const created = await author.post('/api/tickets', {
      type: 'problem', categoryId: categoryId(app, 'Обучение'), isAnonymous: true,
      title: 'Наставник срывает занятия группы', description: 'Секретная подробность фиолетовыйслон закрыта от коллег.',
    });
    const id = created.json.data.id;
    const stranger = await app.as('Менеджер по продажам');
    const byText = (await stranger.get(`/api/tickets/similar?text=${encodeURIComponent('фиолетовыйслон закрыта подробность')}`)).json.data;
    assert.ok(!byText.some((s) => s.id === id), 'по тексту чужое не находится');
    const byTitle = (await stranger.get(`/api/tickets/similar?text=${encodeURIComponent('наставник срывает занятия группы')}`)).json.data.find((s) => s.id === id);
    assert.equal(byTitle.title, null, 'тема анонимного скрыта');
    assert.equal((await author.get(`/api/tickets/similar?text=${encodeURIComponent('фиолетовыйслон закрыта подробность')}`)).json.data.find((s) => s.id === id).title,
      'Наставник срывает занятия группы', 'автор видит своё');
    // Поддержать чужую открытую проблему можно; чужую идею — ответ как у несуществующего.
    assert.equal((await stranger.post(`/api/tickets/${id}/support`)).status, 200);
    const idea = await author.post('/api/tickets', {
      type: 'idea', categoryId: categoryId(app, 'Обучение'), title: 'Закрытая идея для проверки', description: 'Описание закрытой идеи.',
    });
    assert.equal((await stranger.post(`/api/tickets/${idea.json.data.id}/support`)).status, 404);
  });
});
