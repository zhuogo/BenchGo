import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const source = await readFile(new URL('../client/workbench-recovery.mjs', import.meta.url), 'utf8');
const theme = await readFile(new URL('../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css', import.meta.url), 'utf8');
const base = await readFile(new URL('../../../deepseek-harness/packages/client/ui-theme/src/styles/base.css', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:17884/link/workbench/?session=selected';
const status = (instanceId = 'before', overrides = {}) => ({ installation: 'server', current: { plugin: '1.2.0' }, restartRequired: false,
  hostHealth: { instanceId, ready: true, workbench: true, assistant: true, ...overrides } });
let browser;
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
before(async () => { browser = await chromium.launch({ headless: true, executablePath }); });
after(async () => { await browser?.close(); });

async function fixture(t, initial = status(), { mobile = false, dark = false } = {}) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('http://127.0.0.1:17884/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body><main><textarea aria-label="草稿">未发送的内容</textarea></main><aside inert>原有锁定区域</aside></body></html>' }));
  await page.goto(origin);
  await page.addStyleTag({ content: theme + base });
  if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
  await page.clock.install();
  await page.evaluate(value => {
    window.state = value;
    window.reloads = [];
    window.reads = 0;
    localStorage.setItem('draft', '未发送的内容');
    document.querySelector('textarea').focus();
  }, initial);
  await page.addScriptTag({ content: source.replace('export function ', 'function ') + `
    watchWorkbench(async () => { window.reads++; if (window.offline) throw Error('offline'); return window.state; }, {
      reload: () => window.reloads.push({ url: location.href, draft: localStorage.getItem('draft') }),
    });` });
  return page;
}
async function advance(page, state, ms = 15000) {
  await page.evaluate(value => { window.state = value; window.offline = false; }, state);
  await page.clock.fastForward(ms);
}

test('recovery waits for target and assistant, retaining page origin and persisted draft', async t => {
  const page = await fixture(t);
  await advance(page, status('before', { restart: 'restarting', target: '1.3.0' }));
  assert.match(await page.getByRole('status').textContent(), /正在重启/);
  assert.equal(await page.locator('main').evaluate(element => element.inert), true);
  await page.evaluate(() => { window.offline = true; });
  await page.clock.fastForward(5000);
  assert.match(await page.getByRole('status').textContent(), /重新连接/);
  await advance(page, status('after', { ready: false, requiresAssistant: true, assistant: false }));
  assert.match(await page.getByRole('status').textContent(), /总助手/);
  await advance(page, status('after'));
  assert.equal(await page.evaluate(() => reloads.length), 0, 'older loaded package cannot complete recovery');
  const ready = status('after'); ready.current.plugin = '1.3.0';
  await advance(page, ready);
  assert.deepEqual(await page.evaluate(() => reloads), [{ url: origin, draft: '未发送的内容' }]);
  assert.equal(await page.locator('main').evaluate(element => element.inert), false);
  assert.equal(await page.locator('aside').evaluate(element => element.inert), true);
  await page.clock.fastForward(30_000);
  assert.equal(await page.evaluate(() => reloads.length), 1);
});

test('instance change is recovered even when the polling interval missed the outage', async t => {
  const page = await fixture(t);
  await advance(page, status('after'));
  assert.equal(await page.evaluate(() => reloads.length), 1);
});

test('first status failure leaves the document usable until a restart can be identified', async t => {
  const page = await fixture(t, undefined);
  // A fresh document observes the failure before it has a host instance ID.
  await page.reload();
  await page.evaluate(() => { window.reloads = 0; });
  await page.addScriptTag({ content: source.replace('export function ', 'function ') + `
    let first = true;
    watchWorkbench(async () => { if (first) { first = false; throw Error('offline'); }
      return ${JSON.stringify(status('after'))}; }, { reload: () => window.reloads++ });` });
  await page.clock.fastForward(30_000);
  assert.equal(await page.evaluate(() => reloads), 0);
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await page.locator('main').evaluate(element => element.inert), false);
});

test('timeout supports keyboard retry and uses mobile dark theme tokens', async t => {
  const page = await fixture(t, status(), { mobile: true, dark: true });
  await advance(page, status('before', { restart: 'restarting' }));
  await page.evaluate(() => { window.offline = true; });
  await page.clock.fastForward(15000);
  await page.clock.fastForward(180_000);
  const button = page.getByRole('button', { name: '重试连接' });
  assert.equal(await button.evaluate(element => document.activeElement === element), true);
  assert.equal(await page.getByRole('status').evaluate(element => getComputedStyle(element.parentElement).backgroundColor === getComputedStyle(document.body).backgroundColor), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir(new URL('../../../artifacts/update-recovery/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../../artifacts/update-recovery/mobile-dark.png', import.meta.url)) });
  await page.evaluate(value => { window.offline = false; window.state = value; }, status('after'));
  await button.press('Enter');
  assert.equal(await page.evaluate(() => reloads.length), 1);
});

test('failed restart returns to the update controls and restores focus', async t => {
  const page = await fixture(t);
  await advance(page, status('before', { restart: 'restarting' }));
  await advance(page, { ...status('before', { restart: 'failed' }), error: '服务重启失败，请重试' });
  await mkdir(new URL('../../../artifacts/update-recovery/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../../artifacts/update-recovery/desktop-light.png', import.meta.url)) });
  await page.getByRole('button', { name: '返回工作台' }).click();
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await page.getByRole('textbox').evaluate(element => document.activeElement === element), true);
});

test('expired authorization releases the overlay for the existing connection recovery', async t => {
  const page = await fixture(t);
  await advance(page, status('before', { restart: 'restarting' }));
  await advance(page, null);
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await page.locator('main').evaluate(element => element.inert), false);
});

test('desktop host polling stays outside server restart recovery', async t => {
  const page = await fixture(t, { installation: 'desktop' });
  await advance(page, status('after'));
  assert.equal(await page.getByRole('status').count(), 0);
  assert.equal(await page.evaluate(() => reloads.length), 0);
});
