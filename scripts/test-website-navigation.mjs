import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, readdir, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(join(process.env.APPDATA, 'npm/node_modules/draftgo-cli/package.json'));
const {chromium} = require('playwright-core');
const root = new URL('../benchgo-web/site/', import.meta.url);
const site = JSON.parse(await readFile(new URL('site.json', root), 'utf8'));
const live = process.argv.includes('--live');
const directory = fileURLToPath(new URL('../benchgo-web/.draftgo/artifacts/navigation/', import.meta.url));
await mkdir(directory, {recursive: true});
const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
let server;
const startupRecoveries = [];

// Run against every HTML source, including future pages, rather than a fixed list of links.
async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...await htmlFiles(url));
    else if (entry.name.endsWith('.html')) files.push(url);
  }
  return files;
}

function unsafeLinks({html, origin, shell = false}) {
  const doc = html === undefined ? document : new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('a[href]')).flatMap(link => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return [];
    const url = new URL(href, origin);
    if (url.origin !== origin || !/^https?:$/.test(url.protocol)) return [];
    if (shell) return [];
    // Only the document centre's existing, explicit article navigation owns these clicks.
    const onclick = link.getAttribute('onclick') || '';
    if (/^\/docs(?:\/|$)/.test(url.pathname) && /^event\.preventDefault\(\);(?:openArticle|goHome)\(/.test(onclick)) return [];
    if (['_top', '_blank'].includes(link.target.toLowerCase())) return [];
    return [{href, text: link.textContent.trim(), target: link.target}];
  });
}

async function assertSingleNavigation(page) {
  const counts = await Promise.all(page.frames().map(async frame => ({top: frame === page.mainFrame(), count: await frame.locator('#benchgo-nav').count()})));
  assert.equal(counts.reduce((total, frame) => total + frame.count, 0), 1, 'exactly one navigation across all frames');
  assert(counts.every(frame => frame.top || frame.count === 0), 'no navigation in a content iframe');
}

async function assertTheme(page, frame, theme) {
  const nav = page.locator('#benchgo-nav');
  const toggle = nav.locator('#benchgo-theme');
  assert.equal(await toggle.getAttribute('aria-pressed'), String(theme === 'dark'));
  assert.equal(await frame.evaluate(() => getComputedStyle(document.body).colorScheme), theme);
  assert.equal(await nav.evaluate(el => getComputedStyle(el).backgroundColor),
    await frame.evaluate(() => getComputedStyle(document.body).backgroundColor));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}

async function assertHomeContrast(frame) {
  const failures = await frame.evaluate(() => {
    const channels = css => css.match(/[\d.]+/g).map(Number);
    const luminance = ([r, g, b]) => [r,g,b].map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [.2126,.7152,.0722][i], 0);
    const selectors = [
      '.hero-intro', '.hero .button', '.slip-meta', '.sidebar-label', '.step-state',
      '.step-desc', '.demo-status', '.memory-line', '.device-task', '.download-card p', '.footer-note',
    ];
    return selectors.flatMap(selector => {
      const element = document.querySelector(selector);
      const ink = luminance(channels(getComputedStyle(element).color));
      let background = element;
      while (getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') {
        background = background.parentElement;
      }
      const paper = luminance(channels(getComputedStyle(background).backgroundColor));
      const contrast = (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
      return contrast < 4.5 ? [{selector, contrast}] : [];
    });
  });
  assert.deepEqual(failures, [], 'home text contrast is at least 4.5:1');
}

async function contentFrame(page, selector) {
  let deadline = Date.now() + 30_000;
  let startupRetried = false;
  while (Date.now() < deadline) {
    // Inspect Playwright frames directly. A popup can replace its initial
    // document while the shell swaps iframe buffers; don't poll that old world.
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      try {
        if (await frame.locator(selector).count()) return frame;
      } catch (error) {
        if (!frame.isDetached() && !/Execution context was destroyed/.test(error.message)) throw error;
      }
    }
    // The public shell can show its existing connection retry before any Page
    // has loaded. Retry that explicit state once, and report it in the result.
    if (!startupRetried && await page.getByText('暂时无法启动', {exact: true}).isVisible()) {
      startupRetried = true;
      startupRecoveries.push({url: page.url(), selector});
      await page.getByRole('button', {name: '重试', exact: true}).click();
      deadline = Date.now() + 30_000;
    }
    await page.waitForTimeout(100);
  }
  const frames = await Promise.all(page.frames().map(async frame => {
    try { return {url: frame.url(), text: (await frame.locator('body').innerText({timeout: 1000})).slice(0, 200)}; }
    catch { return {url: frame.url()}; }
  }));
  throw new Error('Content frame not found: ' + selector + ' at ' + page.url() + ' ' + JSON.stringify(frames));
}

try {
  const auditPage = await browser.newPage();
  const files = await htmlFiles(root);
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    assert.deepEqual(await auditPage.evaluate(unsafeLinks, {html, origin: site.server, shell: file.pathname.endsWith('/navigation.html')}), [], file.pathname + ': unsafe full-page links');
  }
  await auditPage.close();

  let base = site.server;
  if (!live) {
    const pages = new Map(await Promise.all(site.pages.filter(p => p.route !== '/docs').map(async p => [p.route, await readFile(new URL(p.source, root), 'utf8')])));
    const navigation = await readFile(new URL(site.navigation.source, root), 'utf8');
    const shellTheme = `<script>
      const colors = matchMedia('(prefers-color-scheme: dark)');
      const themeKey = 'dg_theme_mode';
      const applyTheme = theme => {
        const root = document.documentElement;
        root.dataset.theme = theme;
        root.style.setProperty('--dg-bg-base', theme === 'dark' ? '#09090b' : '#ffffff');
        window.dispatchEvent(new CustomEvent('dg:theme-changed', {detail: {theme}}));
      };
      const setInitialTheme = () => applyTheme(localStorage.getItem(themeKey) || (colors.matches ? 'dark' : 'light'));
      window.App = {
        lang: navigator.language,
        locales: ['zh-CN', 'en-US'],
        setLang() {},
        toggleTheme() {
          const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          localStorage.setItem(themeKey, theme);
          applyTheme(theme);
        }
      };
      setInitialTheme();
      colors.addEventListener('change', setInitialTheme);
    </script>`;
    const docsHtml = await readFile(new URL('docs.html', root), 'utf8');
    const enhanceArticle = docsHtml.slice(docsHtml.indexOf('function enhanceArticle(article) {'), docsHtml.indexOf('\nfunction isTransparentColor'));
    assert(enhanceArticle.startsWith('function enhanceArticle(article) {'), 'article link implementation found');
    const articleHtml = await readFile(new URL('documents/install.html', root), 'utf8');
    // Execute the real link enhancement inside the Page sandbox, with an isolated
    // inner article frame. Native popups here inherit restrictions; top.open must not.
    const docsFixture = '<!doctype html><iframe id="doc-frame" sandbox="allow-same-origin allow-popups" style="width:100%;height:900px"></iframe><script>' +
      'const state={pendingScroll:null};const getArticleFrameDoc=()=>document.querySelector("#doc-frame").contentDocument;' +
      'const syncArticleFrameTheme=()=>{},watchArticleFrameHeight=()=>{},applyArticleFrameEdge=()=>{},buildTOC=()=>{},enhanceCodeBlocks=()=>{},enhanceTabs=()=>{},enhanceAccordions=()=>{},highlightCode=()=>{},bindScrollSpy=()=>{};' +
      'const scrollToHeading=id=>{document.documentElement.dataset.anchor=id;};' + enhanceArticle +
      ';const frame=document.querySelector("#doc-frame");frame.onload=()=>enhanceArticle({});frame.srcdoc=' +
      JSON.stringify('<!doctype html><html><body>' + articleHtml + '<a href="#fixture-anchor">文章锚点</a><h2 id="fixture-anchor">锚点目标</h2></body></html>') + ';</script>';
    pages.set('/docs/install', docsFixture);
    pages.set('/docs/linux-server', docsFixture);
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.pathname === '/assets/tailwindcss.js') return res.end('');
      if (url.pathname === '/body') {
        const html = pages.get(url.searchParams.get('route')) || '';
        return res.end(html.replace('</head>', '<style>body {background-color: #999}</style></head>'));
      }
      // Model the real shell boundary: a full route includes navigation plus a content frame.
      res.end('<!doctype html><html><head><meta charset="utf-8">' + shellTheme +
        '<style>body {margin:0;font-family:system-ui} iframe {display:block}</style></head><body>' +
        '<div id="nav-container">' + navigation + '</div><iframe sandbox="allow-scripts allow-same-origin allow-popups allow-top-navigation-by-user-activation" style="width:100%;height:900px;border:0" src="/body?route=' + encodeURIComponent(url.pathname) + '"></iframe></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }

  const results = [];
  for (const width of [1440, 375]) {
    const context = await browser.newContext({viewport: {width, height: 1000}, colorScheme: 'dark', reducedMotion: 'reduce', locale: width === 375 ? 'en-US' : 'zh-CN'});
    const page = await context.newPage();
    // Navigation testing must not depend on GitHub availability or release contents.
    await context.route('https://api.github.com/**', route => route.fulfill({json: []}));
    for (const [from, selector, to] of [
      ['/', '.hero a[href="/download"]', '/download'],
      ['/', '.footer-wordmark', '/'],
      ['/download', '.footer a[href="/"]', '/'],
    ]) {
      await page.goto(base + from, {waitUntil: 'networkidle'});
      const frame = await contentFrame(page, selector);
      // Enter follows the same native link path as a click, including its target.
      const navigated = page.waitForNavigation({waitUntil: 'networkidle'});
      if (selector === '.footer-wordmark') { await frame.locator(selector).focus(); await frame.locator(selector).press('Enter'); }
      else await frame.locator(selector).click();
      await navigated;
      await contentFrame(page, to === '/download' ? '#release-version' : '.hero');
      assert.equal(new URL(page.url()).pathname, to);
      await assertSingleNavigation(page);
      results.push({width, from, selector, to});
    }
    await page.goto(base + '/', {waitUntil: 'networkidle'});
    const home = await contentFrame(page, '.hero');
    const toggle = page.locator('#benchgo-theme');
    await page.setViewportSize({width: width === 375 ? 320 : width, height: 1000});
    await assertTheme(page, home, 'dark');
    await assertHomeContrast(home);
    assert.equal(await home.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: join(directory, (live ? 'live' : 'local') + '-home-dark-' + width + '.png')});
    await toggle.focus();
    await toggle.press('Enter');
    await assertTheme(page, home, 'light');
    assert.equal(await toggle.evaluate(el => document.activeElement === el), true);
    await page.screenshot({path: join(directory, (live ? 'live' : 'local') + '-home-light-' + width + '.png')});
    await page.reload({waitUntil: 'networkidle'});
    const reloadedHome = await contentFrame(page, '.hero');
    await assertTheme(page, reloadedHome, 'light');
    await assertHomeContrast(reloadedHome);
    await toggle.click();
    await assertTheme(page, reloadedHome, 'dark');
    await page.goto(base + '/download', {waitUntil: 'networkidle'});
    await assertTheme(page, await contentFrame(page, '#release-version'), 'dark');
    await page.setViewportSize({width, height: 1000});
    await page.goto(base + '/', {waitUntil: 'networkidle'});
    const shownHome = await contentFrame(page, '.hero');
    await shownHome.locator('a[href="#demo"]').click();
    assert.equal(new URL(page.url()).pathname, '/');
    await assertSingleNavigation(page);
    // Route semantics are viewport-independent: audit the complete route set
    // once, while exercising the actual link interactions at both widths.
    if (live && width === 1440) {
      const routes = [...site.pages.map(p => p.route), ...site.documents.map(d => '/docs/' + d.slug)];
      for (const route of routes) {
        await page.goto(base + route, {waitUntil: 'networkidle'});
        await contentFrame(page, route.startsWith('/docs/') ? '#doc-frame' : route === '/docs' ? '#content' : route === '/download' ? '#release-version' : '.hero');
        if (route.startsWith('/docs/')) {
          const docs = await contentFrame(page, '#doc-frame');
          await docs.waitForFunction(() => {
            const article = document.querySelector('#doc-frame')?.contentDocument;
            return article?.querySelector('h2') && Array.from(article.querySelectorAll('a[href]')).every(a => a.getAttribute('href').startsWith('#') || a.target === '_blank');
          });
        }
        await assertSingleNavigation(page);
        for (const frame of page.frames()) {
          assert.deepEqual(await frame.evaluate(unsafeLinks, {origin: base, shell: frame === page.mainFrame()}), [], route + ': unsafe rendered links in ' + frame.name());
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, route + ': horizontal overflow');
      }
    }
    // A new tab must escape both article and Page restrictions while the article
    // itself retains its existing sandbox. Cover native keyboard and auxclick.
    await page.goto(base + '/docs/install', {waitUntil: 'networkidle'});
    const docs = await contentFrame(page, '#doc-frame');
    const sandbox = await docs.locator('#doc-frame').getAttribute('sandbox');
    assert.deepEqual(sandbox.split(/\s+/).sort(), ['allow-popups', 'allow-same-origin']);
    const article = await (await docs.locator('#doc-frame').elementHandle()).contentFrame();
    for (const target of ['/download', '/docs/linux-server']) {
      const link = article.locator('a[href="' + target + '"]').first();
      await link.waitFor();
      await article.waitForFunction(target => Array.from(document.querySelectorAll('a[href]')).filter(a => a.getAttribute('href') === target).every(a => a.target === '_blank' && /noopener/.test(a.rel) && /noreferrer/.test(a.rel)), target);
      for (const action of ['click', 'keyboard', 'middle']) {
        const opened = context.waitForEvent('page');
        if (action === 'keyboard') { await link.focus(); await link.press('Enter'); }
        else await link.click(action === 'middle' ? {button: 'middle'} : {});
        const popup = await opened;
        await contentFrame(popup, target === '/download' ? '#empty:not([hidden])' : '#doc-frame');
        assert.equal(new URL(popup.url()).pathname, target);
        assert.equal(await popup.evaluate(() => window.opener === null), true);
        await assertSingleNavigation(popup);
        assert.equal(new URL(page.url()).pathname, '/docs/install');
        await popup.close();
      }
    }
    if (!live) {
      await article.locator('a[href="#fixture-anchor"]').click();
      assert.equal(await docs.locator('html').getAttribute('data-anchor'), 'fixture-anchor');
      assert.equal(context.pages().length, 1, 'article anchors do not open a tab');
    }
    await page.screenshot({path: join(directory, (live ? 'live' : 'local') + '-docs-' + width + '.png'), fullPage: true});
    await context.close();
  }
  console.log(JSON.stringify({passed: true,scope: live ? 'live' : 'local',sourceFiles: files.length, flows: results, anchors: true, articlePopups: ['click', 'keyboard', 'middle'], recursiveFrameCheck: true, startupRecoveries, evidence: relative(process.cwd(), directory)}));
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
