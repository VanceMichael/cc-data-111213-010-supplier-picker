import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Archive } from './archive.js';
import { inspect, sample } from './domain.js';
import { startPortal } from './portal.js';
import { IntakeStore, runTodo } from './intake.js';

const [command = 'demo', ...args] = process.argv.slice(2);

function positional(values) {
  const out = [];
  for (let index = 0; index < values.length; index++) {
    if (values[index] === '--portal') { index++; continue; }
    out.push(values[index]);
  }
  return out;
}
function flag(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : null;
}
async function withPortalAndBrowser(requested, fn) {
  const portal = requested ? null : await startPortal();
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: ['--no-sandbox'] });
  try { return await fn(requested ?? portal.url, browser); }
  finally { await browser.close(); await portal?.close(); }
}
function summarize(record) {
  if (record.status === 'completed')
    return `${record.todoId} 正常完成 主体=${record.todo.subject.name}（${record.todo.subject.taxId}） 分支=${record.todo.branch.id} 页面回读=${JSON.stringify(record.readback?.serverSelection ?? null)}`;
  if (record.status === 'manual') return `${record.todoId} 转人工 ${record.manualReason}`;
  return `${record.todoId} 进行中 ${record.error ?? ''}`;
}

async function run() {
  if (command === 'inspect') {
    if (!args[0]) throw new Error('需要资料路径');
    console.log(JSON.stringify(await inspect(resolve(args[0])), null, 2));
  } else if (command === 'capture') {
    if (!args[0]) throw new Error('需要资料路径');
    const directory = args[1] ?? '.local/archive';
    const inventory = await inspect(resolve(args[0]));
    const receipt = await new Archive(directory).accept(await readFile(args[0]),
      { source: resolve(args[0]), inventory });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(await new Archive(args[0] ?? '.local/archive').receipts(), null, 2));
  } else if (command === 'intake') {
    const [sub, ...rest] = args;
    const requested = flag(rest, '--portal');
    const pos = positional(rest);
    if (sub === 'run') {
      const [todosFile, storeDir = '.local/intake'] = pos;
      if (!todosFile) throw new Error('需要待办文件路径');
      const { todos } = JSON.parse(await readFile(resolve(todosFile), 'utf8'));
      const store = new IntakeStore(storeDir);
      await withPortalAndBrowser(requested, async (url, browser) => {
        for (const todo of todos)
          console.log(summarize(await runTodo({ todo, store, portalUrl: url, browser })));
      });
    } else if (sub === 'resume') {
      const [storeDir = '.local/intake', todoId] = pos;
      if (!todoId) throw new Error('需要待办编号');
      const store = new IntakeStore(storeDir);
      const existing = await store.load(todoId);
      if (!existing) throw new Error(`没有 ${todoId} 的录入记录`);
      await withPortalAndBrowser(requested, async (url, browser) => {
        console.log(summarize(await runTodo({ todo: existing.todo, store, portalUrl: url, browser })));
      });
    } else if (sub === 'list') {
      const records = await new IntakeStore(pos[0] ?? '.local/intake').list();
      for (const record of records) console.log(`${record.updatedAt} ${summarize(record)}`);
      const manual = records.filter(record => record.status === 'manual');
      if (manual.length)
        console.log(`转人工 ${manual.length} 项：人工查询入口保留，可运行 npm start 打开本地门户处理`);
    } else { throw new Error('支持 intake run、intake resume、intake list'); }
  } else if (command === 'demo') {
    const temporary = await mkdtemp(join(tmpdir(), 'intake-'));
    try {
      const inventory = await inspect(resolve(sample));
      const archive = new Archive(temporary);
      const receipt = await archive.accept(await readFile(sample), { source: sample, inventory });
      console.log(JSON.stringify({ inventory, receipt, verified: (await archive.read(receipt.sha256)).length }, null, 2));
      const domain = await import('./domain.js');
      console.log(JSON.stringify(await domain.livePreview(), null, 2));
      const { todos } = JSON.parse(await readFile(resolve('fixtures/todos.json'), 'utf8'));
      const store = new IntakeStore(join(temporary, 'intake'));
      await withPortalAndBrowser(null, async (url, browser) => {
        for (const todo of todos)
          console.log(summarize(await runTodo({ todo, store, portalUrl: url, browser })));
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } else { throw new Error('支持 inspect、capture、list、intake、demo'); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
