import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startPortal } from '../src/portal.js';
import { IntakeStore, runTodo } from '../src/intake.js';

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser.close(); });

const TODO_B = { id: 'T-101', subject: { name: '远航设备', taxId: 'SYN-002' }, branch: { id: 'B1', name: '东区' } };

async function setup(t, control) {
  const portal = await startPortal();
  if (control) {
    const response = await fetch(`${portal.url}/api/control`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(control) });
    assert.equal(response.status, 200);
  }
  const directory = await mkdtemp(join(tmpdir(), 'intake-'));
  const context = await browser.newContext();
  t.after(async () => {
    await context.close();
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { portal, store: new IntakeStore(directory), context };
}
const steps = (record, action) => record.steps.filter(step => step.action === action);

test('重名名录中按税号选定主体并约束分支，记录查找依据与页面回读', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  const record = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(record.status, 'completed');
  assert.deepEqual(portal.state.selection, { subject: 'B', branch: 'B1' });
  const lookups = steps(record, 'lookup');
  assert.equal(lookups.length, 1);
  assert.match(lookups[0].basis, /名称/);
  assert.equal(lookups[0].candidates.length, 2);
  assert.equal(lookups[0].matched, 1);
  assert.equal(steps(record, 'subject-select')[0].readback.taxId, 'SYN-002');
  const branch = steps(record, 'branch-select')[0];
  assert.deepEqual(branch.before, []);
  assert.deepEqual(branch.after, ['B1']);
  assert.equal(branch.readback, 'B1');
  assert.equal(record.readback.serverSelection.subject, 'B');
  assert.equal(record.readback.page.taxId, 'SYN-002');
  const persisted = await store.load(TODO_B.id);
  assert.equal(persisted.status, 'completed');
});

test('乱序到达的检索响应不影响按最终查询确定身份', async (t) => {
  const { portal, store, context } = await setup(t, { searchDelay: { 'SYN-00': 300, 'SYN-0': 80 } });
  const page = await context.newPage();
  const todo = { id: 'T-102', subject: { name: '未入录名称', taxId: 'SYN-002' }, branch: { id: 'B1', name: '东区' } };
  const record = await runTodo({ todo, store, portalUrl: portal.url, page });
  assert.equal(record.status, 'completed');
  const lookups = steps(record, 'lookup');
  assert.equal(lookups.length, 2);
  assert.equal(lookups[1].query, 'SYN-002');
  assert.deepEqual(lookups[1].candidates.map(candidate => candidate.taxId), ['SYN-002']);
  assert.deepEqual(portal.state.selection, { subject: 'B', branch: 'B1' });
});

test('中文输入法组词过程中不触发检索', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  const queries = [];
  await page.route('**/api/search**', route => {
    queries.push(new URL(route.request().url()).searchParams.get('q'));
    return route.continue();
  });
  const record = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(record.status, 'completed');
  assert.deepEqual(queries, ['远航设备']);
});

test('虚拟化候选列表中滚动定位目标税号', async (t) => {
  const extra = Array.from({ length: 30 }, (_, index) =>
    ({ id: `S${index}`, name: '远航设备', taxId: `SYN-1${String(index).padStart(2, '0')}` }));
  const control = {
    suppliers: [{ id: 'A', name: '远航设备', taxId: 'SYN-001' },
      { id: 'B', name: '远航设备', taxId: 'SYN-002' }, ...extra],
    branches: { A: [{ id: 'A1', name: '东区' }], B: [{ id: 'B1', name: '东区' }],
      S17: [{ id: 'S17-1', name: '西区' }] },
  };
  const { portal, store, context } = await setup(t, control);
  const page = await context.newPage();
  const todo = { id: 'T-103', subject: { name: '远航设备', taxId: 'SYN-117' }, branch: { id: 'S17-1', name: '西区' } };
  const record = await runTodo({ todo, store, portalUrl: portal.url, page });
  assert.equal(record.status, 'completed');
  assert.equal(steps(record, 'lookup')[0].candidates.length, 32);
  assert.deepEqual(portal.state.selection, { subject: 'S17', branch: 'S17-1' });
});

test('隐藏根节点重建后重新核验身份并完成', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  let rebuilt = false;
  const hooks = { afterStep: async (page, action) => {
    if (action === 'subject-select' && !rebuilt) {
      rebuilt = true;
      await page.evaluate(() => {
        const old = document.querySelector('supplier-search');
        old.replaceWith(document.createElement('supplier-search'));
      });
    }
  } };
  const record = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page, hooks });
  assert.equal(record.status, 'completed');
  assert.equal(steps(record, 'subject-select').length, 2);
  assert.deepEqual(portal.state.selection, { subject: 'B', branch: 'B1' });
});

test('恢复时识别页面已被人工改选并转人工，不覆盖人工登记', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  const first = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(first.status, 'completed');
  await page.getByRole('combobox', { name: '主体名称或税号' }).fill('SYN-001');
  await page.getByRole('option').filter({ hasText: 'SYN-001' }).click();
  await page.getByRole('combobox', { name: '分支机构' }).selectOption('A1');
  await page.getByRole('button', { name: '登记选择' }).click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('A1'));
  assert.deepEqual(portal.state.selection, { subject: 'A', branch: 'A1' });
  const resumed = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(resumed.status, 'manual');
  assert.match(resumed.manualReason, /人工改选/);
  assert.ok(resumed.detectedChanges.some(change => change.kind === 'selection-conflict'));
  assert.deepEqual(portal.state.selection, { subject: 'A', branch: 'A1' });
});

test('登记被清空不属于人工改选，恢复时重新登记', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  const first = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(first.status, 'completed');
  await fetch(`${portal.url}/api/control`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selection: null }) });
  const resumed = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(resumed.status, 'completed');
  assert.ok(resumed.detectedChanges.some(change => change.kind === 'selection-cleared'));
  assert.deepEqual(portal.state.selection, { subject: 'B', branch: 'B1' });
});

test('中断后从录入记录恢复并完成', async (t) => {  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  let crashed = false;
  const hooks = { afterStep: async (page, action) => {
    if (action === 'subject-select' && !crashed) { crashed = true; throw new Error('模拟进程中断'); }
  } };
  await assert.rejects(runTodo({ todo: TODO_B, store, portalUrl: portal.url, page, hooks }), /模拟进程中断/);
  const interrupted = await store.load(TODO_B.id);
  assert.equal(interrupted.status, 'in-progress');
  assert.equal(steps(interrupted, 'subject-select').length, 1);
  const resumed = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(portal.state.selection, { subject: 'B', branch: 'B1' });
  assert.ok(steps(resumed, 'subject-recheck').length + steps(resumed, 'subject-select').length >= 2);
});

test('税号在名录中无对应候选时转人工且不试点', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  const todo = { id: 'T-104', subject: { name: '远航设备', taxId: 'SYN-009' }, branch: { id: 'B1', name: '东区' } };
  const record = await runTodo({ todo, store, portalUrl: portal.url, page });
  assert.equal(record.status, 'manual');
  assert.match(record.manualReason, /找不到税号/);
  assert.equal(steps(record, 'subject-select').length, 0);
  assert.equal(portal.state.selection, undefined);
});

test('税号对应多个候选时转人工', async (t) => {
  const control = { suppliers: [
    { id: 'A', name: '远航设备', taxId: 'SYN-001' },
    { id: 'B', name: '远航设备', taxId: 'SYN-002' },
    { id: 'C', name: '远航设备', taxId: 'SYN-002' } ] };
  const { portal, store, context } = await setup(t, control);
  const page = await context.newPage();
  const record = await runTodo({ todo: TODO_B, store, portalUrl: portal.url, page });
  assert.equal(record.status, 'manual');
  assert.match(record.manualReason, /2 个候选/);
  assert.equal(portal.state.selection, undefined);
});

test('分支不属于所选主体时不沿用屏幕文字并转人工', async (t) => {
  const { portal, store, context } = await setup(t);
  const page = await context.newPage();
  const todo = { id: 'T-105', subject: { name: '远航设备', taxId: 'SYN-001' }, branch: { id: 'B1', name: '东区' } };
  const record = await runTodo({ todo, store, portalUrl: portal.url, page, timeouts: { branch: 600 } });
  assert.equal(record.status, 'manual');
  assert.match(record.manualReason, /未出现待办分支/);
  assert.equal(portal.state.selection, undefined);
});
