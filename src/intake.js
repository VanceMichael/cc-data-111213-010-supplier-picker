import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './archive.js';

// 转人工信号：候选无法唯一对应税号、页面回读不一致、服务端拒绝等情况，
// 一律抛出此错误并留下记录，不做任何“试点式”重试。
export class ManualRequired extends Error {}

const CJK = /[㐀-鿿]/;
const defaultTimeouts = { portal: 5000, response: 5000, settle: 5000, branch: 5000 };

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// 可恢复的录入记录：每条待办一个 JSON 文件，原子写入，崩溃后可续。
export class IntakeStore {
  constructor(directory) { this.directory = resolve(directory); }
  async initialize() { await mkdir(join(this.directory, 'records'), { recursive: true }); }
  recordPath(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('待办编号格式不正确');
    return join(this.directory, 'records', `${id}.json`);
  }
  async load(id) {
    try { return JSON.parse(await readFile(this.recordPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(record) {
    await this.initialize();
    record.updatedAt = new Date().toISOString();
    const path = this.recordPath(record.todoId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return record;
  }
  async list() {
    await this.initialize();
    const files = (await readdir(join(this.directory, 'records'))).filter(name => name.endsWith('.json'));
    const records = await Promise.all(files.map(name =>
      readFile(join(this.directory, 'records', name), 'utf8').then(JSON.parse)));
    return records.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  }
}

export function newRecord(todo) {
  return { todoId: todo.id, todo, status: 'in-progress', steps: [], detectedChanges: [],
    createdAt: new Date().toISOString() };
}

// 页面回读：嵌套 shadow root 内的输入值、税号回显、分支下拉与登记回执。
export async function readPageDom(page) {
  return page.evaluate(() => {
    const root = document.querySelector('supplier-search')?.shadowRoot
      ?.querySelector('search-input')?.shadowRoot;
    const input = root?.querySelector('input') ?? null;
    const select = document.querySelector('#branch');
    return {
      present: Boolean(input),
      input: input?.value ?? '',
      taxId: root?.querySelector('output')?.textContent?.trim() ?? '',
      branchOptions: select ? [...select.options].map(option => option.value) : [],
      branchValue: select?.value ?? '',
      result: document.querySelector('#result')?.textContent?.trim() ?? '',
      notice: document.querySelector('#notice')?.textContent?.trim() ?? '',
    };
  });
}

// 服务端快照：登记状态与名录版本，用于恢复前识别页面是否被人改过。
export async function serverSnapshot(page) {
  const state = await page.evaluate(() => fetch('/api/state').then(response => response.json()));
  return {
    selection: state.selection ?? null,
    generation: state.generation ?? null,
    directoryHash: digest(stable({ suppliers: state.suppliers ?? [], branches: state.branches ?? {} })),
  };
}

export function detectChanges(record, now) {
  const before = record.serverSnapshot;
  const at = new Date().toISOString();
  const changes = [];
  if (before.generation !== now.generation || before.directoryHash !== now.directoryHash)
    changes.push({ at, kind: 'directory-changed', from: before.generation, to: now.generation });
  if (stable(before.selection ?? null) !== stable(now.selection ?? null)) {
    const expected = record.matchedSubject
      ? { subject: record.matchedSubject, branch: record.todo.branch.id } : null;
    if (!now.selection)
      changes.push({ at, kind: 'selection-cleared', recorded: before.selection ?? null });
    else if (expected && stable(now.selection) === stable(expected))
      changes.push({ at, kind: 'selection-matches-todo', current: now.selection });
    else
      changes.push({ at, kind: 'selection-conflict', recorded: before.selection ?? null,
        current: now.selection ?? null });
  }
  return changes;
}

// 执行一条待办：加载既有记录（如有），识别恢复前的人工改动，然后走完整核验流程。
export async function runTodo({ todo, store, portalUrl, browser, page, hooks = {}, timeouts = {}, inputMode = 'auto' }) {
  if (!todo?.id) throw new Error('待办缺少编号');
  const record = (await store.load(todo.id)) ?? newRecord(todo);
  record.todo = todo;
  const ownPage = !page;
  if (ownPage) page = await browser.newPage();
  const persist = () => store.save(record);
  try {
    const reused = page.url().startsWith(portalUrl);
    if (!reused) await page.goto(portalUrl);
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.length > 0,
      null, { timeout: timeouts.portal ?? defaultTimeouts.portal });
    const now = await serverSnapshot(page);
    if (record.serverSnapshot) {
      const changes = detectChanges(record, now);
      if (reused && record.domSnapshot) {
        const dom = await readPageDom(page);
        const pristine = !dom.input && !dom.taxId && !dom.result && dom.branchOptions.length === 0;
        if (!pristine && stable(dom) !== stable(record.domSnapshot))
          changes.push({ at: new Date().toISOString(), kind: 'page-changed',
            recorded: record.domSnapshot, current: dom });
      }
      if (changes.length) record.detectedChanges.push(...changes);
      const conflict = changes.find(change => change.kind === 'selection-conflict');
      if (conflict) {
        record.status = 'manual';
        record.manualReason = `恢复前检测到人工改选：登记状态 ${JSON.stringify(conflict.current)} 与待办身份不一致，不覆盖人工登记`;
        await persist();
        return record;
      }
    }
    record.serverSnapshot = now;
    const flow = new Flow(page, record, todo,
      { hooks, timeouts: { ...defaultTimeouts, ...timeouts }, inputMode, persist });
    await flow.run();
    record.status = 'completed';
    record.serverSnapshot = await serverSnapshot(page);
    record.domSnapshot = await readPageDom(page);
    delete record.error;
    delete record.manualReason;
    await persist();
    return record;
  } catch (error) {
    if (error instanceof ManualRequired) {
      record.status = 'manual';
      record.manualReason = error.message;
      await persist();
      return record;
    }
    record.status = 'in-progress';
    record.error = error.message;
    await persist();
    throw error;
  } finally {
    if (ownPage) await page.close();
  }
}

class Flow {
  constructor(page, record, todo, opts) {
    this.page = page;
    this.record = record;
    this.todo = todo;
    this.opts = opts;
    this.combo = page.getByRole('combobox', { name: '主体名称或税号' });
    this.branchSelect = page.getByRole('combobox', { name: '分支机构' });
  }
  async note(action, detail) {
    this.record.steps.push({ at: new Date().toISOString(), action, ...detail });
    await this.opts.persist();
    await this.opts.hooks.afterStep?.(this.page, action, this.record);
  }
  subjectPresent(dom) {
    const name = this.matched?.name ?? this.record.matchedName;
    return dom.present && Boolean(name) && dom.taxId === this.todo.subject.taxId && dom.input === name;
  }
  async run() {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!(await this.ensureSubject())) continue;
      if (!(await this.ensureBranch())) continue;
      if (!(await this.ensureSaved())) continue;
      return;
    }
    throw new ManualRequired('页面状态在录入过程中反复变化，转人工核对');
  }
  async ensureSubject() {
    const dom = await readPageDom(this.page);
    if (this.subjectPresent(dom) && this.record.matchedSubject && this.record.matchedName) {
      this.matched = { subject: this.record.matchedSubject,
        name: this.record.matchedName, taxId: this.todo.subject.taxId };
      await this.note('subject-recheck', {
        basis: '页面已显示待办身份，沿用名录复核结果，不重复点击',
        readback: { input: dom.input, taxId: dom.taxId } });
      return true;
    }
    const candidate = await this.lookup();
    this.matched = candidate;
    this.record.matchedSubject = candidate.subject;
    this.record.matchedName = candidate.name;
    this.branchBefore = (await readPageDom(this.page)).branchOptions;
    await this.clickCandidate(candidate);
    const after = await readPageDom(this.page);
    if (!this.subjectPresent(after))
      throw new ManualRequired(`点击候选后页面回读「${after.input}/${after.taxId}」与名录身份「${candidate.name}/${candidate.taxId}」不一致，不继续尝试`);
    await this.note('subject-select', {
      basis: `按税号 ${candidate.taxId} 唯一命中后点击选项「${candidate.text}」（身份以税号为准，不按位置）`,
      readback: { input: after.input, taxId: after.taxId } });
    return true;
  }
  async lookup() {
    const attempts = [
      { value: this.todo.subject.name, reason: `按待办主体名称「${this.todo.subject.name}」检索` },
      { value: this.todo.subject.taxId, reason: `按名称未命中税号，改用待办税号「${this.todo.subject.taxId}」检索` },
    ];
    for (const attempt of attempts) {
      const candidates = await this.search(attempt.value);
      const matches = candidates.filter(candidate => candidate.taxId === this.todo.subject.taxId);
      await this.note('lookup', { basis: attempt.reason, query: attempt.value,
        candidates: candidates.map(candidate => ({ name: candidate.name, taxId: candidate.taxId })),
        matched: matches.length });
      if (matches.length === 1) return matches[0];
      if (matches.length > 1)
        throw new ManualRequired(`税号 ${this.todo.subject.taxId} 在名录中对应 ${matches.length} 个候选，无法唯一确定，不逐一试点`);
    }
    throw new ManualRequired(`名录中找不到税号 ${this.todo.subject.taxId} 对应的法定主体`);
  }
  async search(query) {
    this.lastQuery = query;
    await this.combo.waitFor({ state: 'visible', timeout: this.opts.timeouts.portal });
    await this.combo.evaluate(element => { element.value = ''; });
    // 以“本次查询的响应”为准：慢网络下先到的旧响应不参与判断。
    const pending = this.page.waitForResponse(response => {
      try {
        const url = new URL(response.url());
        return url.pathname === '/api/search' && url.searchParams.get('q') === query;
      } catch { return false; }
    }, { timeout: this.opts.timeouts.response });
    if (this.useIme(query)) await this.imeType(query);
    else await this.combo.pressSequentially(query);
    let data;
    try { data = await (await pending).json(); }
    catch { throw new ManualRequired(`检索「${query}」未在限期内返回`); }
    return (data.candidates ?? []).map(candidate => ({
      subject: candidate.id, name: candidate.name, taxId: candidate.taxId,
      text: `${candidate.name}（${candidate.taxId}）` }));
  }
  useIme(query) {
    return this.opts.inputMode === 'ime' || (this.opts.inputMode === 'auto' && CJK.test(query));
  }
  // 中文输入法组词：组词期间的 input 事件带 isComposing，门户不应触发检索；
  // compositionend 才提交完整查询。
  async imeType(text) {
    await this.combo.evaluate((element, text) => {
      element.focus();
      element.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      element.value = text.slice(0, Math.max(1, text.length - 1));
      element.dispatchEvent(new InputEvent('input',
        { data: element.value, inputType: 'insertCompositionText', isComposing: true }));
      element.value = text;
      element.dispatchEvent(new InputEvent('input',
        { data: text, inputType: 'insertCompositionText', isComposing: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
    }, text);
  }
  async waitListConsistent(query) {
    try {
      await this.page.waitForFunction(query => {
        const root = document.querySelector('supplier-search')?.shadowRoot
          ?.querySelector('search-input')?.shadowRoot;
        if (!root) return false;
        const input = root.querySelector('input');
        const list = root.querySelector('ul');
        if (!input || !list || input.getAttribute('aria-expanded') !== 'true') return false;
        if (input.value !== query) return false;
        const options = [...list.querySelectorAll('[role=option]')];
        return options.length > 0 && options.every(option => option.textContent.includes(query));
      }, query, { timeout: this.opts.timeouts.settle });
    } catch { throw new ManualRequired(`检索「${query}」的候选列表未稳定对应本次查询`); }
  }
  // 虚拟化列表：按视口滚动，等渲染窗口对齐后再找目标税号的选项，不按下标编排。
  async clickCandidate(candidate) {
    await this.waitListConsistent(this.lastQuery);
    const list = this.page.getByRole('listbox');
    const handle = await list.elementHandle();
    const geometry = await handle.evaluate(element =>
      ({ client: element.clientHeight, scroll: element.scrollHeight }));
    const step = Math.max(1, geometry.client);
    const max = Math.max(0, geometry.scroll - geometry.client);
    for (let top = 0; ; top = Math.min(top + step, max)) {
      await this.scrollList(handle, top);
      const option = this.page.getByRole('option').filter({ hasText: `（${candidate.taxId}）` });
      if (await option.count() > 0) {
        const subject = await option.first().getAttribute('data-subject');
        if (subject !== candidate.subject)
          throw new ManualRequired(`候选「${candidate.text}」文字与内部标识不一致，转人工核对`);
        await option.first().click();
        return;
      }
      if (top >= max) break;
    }
    throw new ManualRequired(`候选「${candidate.text}」在虚拟列表中不可定位`);
  }
  async scrollList(handle, top) {
    await handle.evaluate((element, top) => { element.scrollTop = top; }, top);
    try {
      await this.page.waitForFunction(([top]) => {
        const list = document.querySelector('supplier-search')?.shadowRoot
          ?.querySelector('search-input')?.shadowRoot?.querySelector('ul');
        if (!list) return false;
        const first = list.querySelector('[role=option]');
        if (!first) return true;
        const item = parseFloat(first.style.height) || 40;
        const start = parseFloat(first.style.top) || 0;
        return list.scrollTop === top && start <= top && start + item > top;
      }, [top], { timeout: this.opts.timeouts.settle });
    } catch { throw new ManualRequired('虚拟列表滚动后未按预期渲染'); }
  }
  async ensureBranch() {
    const dom = await readPageDom(this.page);
    if (!this.subjectPresent(dom)) return false;
    const before = this.branchBefore ?? dom.branchOptions;
    const expected = this.todo.branch.id;
    try {
      await this.page.waitForFunction(expected => {
        const select = document.querySelector('#branch');
        return select && [...select.options].some(option => option.value === expected);
      }, expected, { timeout: this.opts.timeouts.branch });
    } catch {
      throw new ManualRequired(`主体 ${this.matched.subject} 下未出现待办分支 ${expected}，不沿用屏幕残留分支`);
    }
    const after = (await readPageDom(this.page)).branchOptions;
    await this.branchSelect.selectOption(expected);
    const value = await this.branchSelect.inputValue();
    if (value !== expected)
      throw new ManualRequired(`分支 ${expected} 选择未被页面接受，页面回读为「${value}」`);
    await this.note('branch-select', {
      basis: `主体变更后旧分支已失效，按选项值 ${expected} 选择（显示文字「${this.todo.branch.name}」不作为身份）`,
      before, after, readback: value });
    return true;
  }
  async ensureSaved() {
    const dom = await readPageDom(this.page);
    if (!this.subjectPresent(dom)) return false;
    if (dom.branchValue !== this.todo.branch.id) return false;
    const existing = dom.result ? JSON.parse(dom.result) : null;
    const serverBefore = await serverSnapshot(this.page);
    const registered = serverBefore.selection?.subject === this.matched.subject
      && serverBefore.selection?.branch === this.todo.branch.id;
    if (!registered && existing && existing.subject === this.matched.subject && existing.branch === this.todo.branch.id)
      await this.note('save-redo', { basis: '页面回执仍在但服务端登记已变化，重新提交以恢复一致', readback: existing });
    if (registered && existing && existing.subject === this.matched.subject && existing.branch === this.todo.branch.id) {
      await this.note('save-skip', { basis: '页面已回读相同登记结果且服务端一致，不重复提交', readback: existing });
    } else {
      await this.page.getByRole('button', { name: '登记选择' }).click();
      try {
        await this.page.waitForFunction(() => {
          const text = document.querySelector('#result')?.textContent?.trim() ?? '';
          const notice = document.querySelector('#notice')?.textContent ?? '';
          return text.length > 0 || /不匹配|未接纳|错误/.test(notice);
        }, null, { timeout: this.opts.timeouts.settle });
      } catch { throw new ManualRequired('登记提交后页面未给出回执'); }
      const text = (await this.page.locator('#result').textContent()).trim();
      if (!text) {
        const notice = (await this.page.locator('#notice').textContent()).trim();
        throw new ManualRequired(`登记被服务端拒绝：${notice}，不重复尝试`);
      }
      const result = JSON.parse(text);
      if (result.subject !== this.matched.subject || result.branch !== this.todo.branch.id)
        throw new ManualRequired(`登记回执 ${text} 与待办身份不一致`);
      await this.note('save', { basis: '页面回读登记回执并与待办核对一致', readback: result });
    }
    const server = await serverSnapshot(this.page);
    if (server.selection?.subject !== this.matched.subject || server.selection?.branch !== this.todo.branch.id)
      throw new ManualRequired('服务端登记状态与页面回执不一致');
    this.record.readback = {
      subject: this.matched,
      branch: { id: this.todo.branch.id, name: this.todo.branch.name },
      page: await readPageDom(this.page),
      serverSelection: server.selection,
    };
    return true;
  }
}
