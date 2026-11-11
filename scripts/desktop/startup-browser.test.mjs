import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareDesktopRenderer } from './prepare-brand.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value));

test('prepared startup keeps one brand entrance, local eye expressions, live themes and recoverable navigation', { skip: !executablePath && 'Chromium/Edge is required' }, async t => {
  const prepared = await mkdtemp(join(tmpdir(), 'benchgo-startup-browser-'));
  t.after(() => rm(prepared, { recursive: true, force: true }));
  await prepareDesktopRenderer(root, prepared);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const screenshots = process.env.BENCHGO_STARTUP_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 300 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.startupCalls = 0;
    window.startupFail = true;
    window.dshWelcome = { skip: async () => {
      window.startupCalls++;
      if (window.startupFail) throw Error('fixture navigation failed');
    } };
  });
  const snapshot = async name => {
    if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) });
  };
  const surface = () => page.evaluate(() => ({
    root: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.querySelector('h1')).color,
    overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
  }));
  for (const name of ['splash.html', 'welcome.html']) {
    await page.goto(pathToFileURL(join(prepared, name)).href);
    await page.locator('.startup-mascot [data-part="eyes"]').waitFor();
    const entrance = await page.evaluate(() => {
      const brand = document.querySelector('.startup-brand');
      const animation = brand.getAnimations().find(item => item.animationName === 'startup-arrive');
      animation.pause(); animation.currentTime = 120;
      const mascot = brand.querySelector('.startup-mascot');
      const title = brand.querySelector('h1');
      return {
        duration: animation.effect.getTiming().duration,
        delay: animation.effect.getTiming().delay,
        opacity: Number(getComputedStyle(brand).opacity),
        childAnimations: mascot.getAnimations().length + title.getAnimations().length,
        artworkBackground: getComputedStyle(mascot).backgroundColor,
        artworkBorder: getComputedStyle(mascot).borderWidth,
        artworkFilter: getComputedStyle(mascot.querySelector('[data-effect="soft-shadow"]')).filter,
        hasBackgroundPlate: !!mascot.querySelector(':scope > rect'),
      };
    });
    assert.equal(entrance.duration, 240);
    assert.equal(entrance.delay, 0);
    assert(entrance.opacity > 0 && entrance.opacity < 1);
    assert.equal(entrance.childAnimations, 0, 'both children inherit the same parent entrance');
    assert.equal(entrance.artworkBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(entrance.artworkBorder, '0px');
    assert.equal(entrance.artworkFilter, 'none', 'blinking does not rerasterize a full-artwork SVG filter');
    assert.equal(entrance.hasBackgroundPlate, false);
    await snapshot(name + '-entering');
    await page.evaluate(() => document.querySelector('.startup-brand').getAnimations()[0].finish());
    for (const [theme, background, foreground] of [['light', 'rgb(255, 255, 255)', 'rgb(32, 33, 36)'], ['dark', 'rgb(25, 25, 27)', 'rgb(237, 237, 238)']]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
      await page.waitForFunction(expected => getComputedStyle(document.body).backgroundColor === expected && document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth, background);
      assert.deepEqual(await surface(), { root: background, body: background, text: foreground, overflow: false });
      await snapshot(name + '-' + theme);
    }
    const eyeScale = await page.evaluate(() => {
      const eyes = document.querySelector('[data-part="eyes"]');
      const animation = eyes.getAnimations()[0];
      animation.pause(); animation.currentTime = 250 + 3200 * .1;
      return new DOMMatrix(getComputedStyle(eyes).transform).d;
    });
    assert(Math.abs(eyeScale - .1) < .01, 'only the existing eyes briefly close');
    await snapshot(name + '-blink');
    for (const [pose, progress, shift] of [['look-left', .36, -18], ['look-right', .58, 18], ['look-center', .8, 0]]) {
      const expression = await page.evaluate(progress => {
        const eyes = document.querySelector('[data-part="eyes"]');
        const animations = eyes.getAnimations();
        animations[0].currentTime = 250 + 3200 * progress;
        const matrix = new DOMMatrix(getComputedStyle(eyes).transform);
        return { shift: matrix.e, scale: matrix.d, animations: animations.length, bodyTransform: getComputedStyle(document.querySelector('[data-part="body"]')).transform };
      }, progress);
      assert.deepEqual(expression, { shift, scale: 1, animations: 1, bodyTransform: 'none' }, 'one transform moves only the existing eyes and returns them to center');
      await snapshot(name + '-' + pose);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await page.evaluate(() => ({
      animations: document.getAnimations().length,
      opacity: getComputedStyle(document.querySelector('.startup-brand')).opacity,
      transform: getComputedStyle(document.querySelector('[data-part="eyes"]')).transform,
    })), { animations: 0, opacity: '1', transform: 'none' });
    await snapshot(name + '-reduced');
    if (name === 'welcome.html') {
      await page.getByRole('button', { name: '重试' }).waitFor();
      assert.equal(await page.locator('#startup-status').innerText(), '工作台未能打开，请重试');
      assert.equal(await page.locator('.startup-loading').isVisible(), false);
      await snapshot('welcome-error');
      await page.evaluate(() => { window.startupFail = false; });
      await page.getByRole('button', { name: '重试' }).click();
      await page.getByRole('button', { name: '重试' }).waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.startupCalls), 2);
      assert.equal(await page.locator('#startup-status').innerText(), '');
      await snapshot('welcome-ready');
    }
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  }
  assert.deepEqual(errors, []);
});
