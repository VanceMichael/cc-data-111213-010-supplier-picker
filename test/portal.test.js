import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startPortal} from '../src/portal.js';
test('本地门户现有人工操作可执行且保持业务边界',{timeout:25000},async()=>{
  const portal=await startPortal();
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const page=await browser.newPage();await page.goto(portal.url);await page.waitForFunction(()=>document.querySelector('#notice').textContent.length>0);

await page.getByRole('combobox',{name:'主体名称或税号'}).fill('SYN-002');
await page.getByRole('option').filter({hasText:'SYN-002'}).click();
await page.locator('#branch').selectOption('B1');
await page.getByRole('button',{name:'登记选择'}).click();
await page.waitForFunction(() => document.querySelector('#result').textContent.includes('B1'));
assert.equal(portal.state.selection.subject, 'B');

  }finally{await browser.close();await portal.close();}
});
