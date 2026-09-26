// Тесты гейта без реальных ожиданий: page.clock (виртуальное время) + page.route (моки сети).
// Сервер нужен только как origin для /telegram_auth_gate.js и jQuery; состояние доступа —
// флаги access/statusAuthorized, серверные файлы не трогаем.
const { test, expect } = require('@playwright/test');
const { harnessHtml } = require('./harness');

const BASE = 'http://127.0.0.1:9118';
const UID = 'hb-e2e-1';

let access;
let statusAuthorized;

async function setupPage(page, initialAccess = true) {
  access = initialAccess;
  statusAuthorized = true;

  await page.addInitScript(() => {
    window.__bootT = performance.timeOrigin;
  });

  await page.route('**/harness', (route) =>
    route.fulfill({ contentType: 'text/html', body: harnessHtml(UID) }));

  await page.route('**/testaccsdb**', (route) => {
    const body = access
      ? { accsdb: false, success: true }
      : { accsdb: true, msg: 'denied ' + UID };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/tg/auth/status**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(statusAuthorized
        ? { authorized: true, message: 'OK' }
        : { authorized: false, message: 'not bound' }),
    }));

  await page.route('**/tg/auth/device/name', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.route('**/online/lite', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ accsdb: true, msg: 'lifeevents: no online' }),
    }));

  await page.clock.install();
  await page.goto(BASE + '/harness');
  // Стартовый checkAutch идёт через setTimeout 500 мс — прокручиваем чанком,
  // затем даём fetch-цепочке завершиться (см. runVirtual).
  await runVirtual(page, 3000, 3000);
}

const overlay = (page) => page.locator('#tg-auth-gate-overlay');
const bootedAt = (page) => page.evaluate(() => window.__bootT);

// Виртуальное время чанками: внутри одного runFor таймеры стреляют, но
// fetch-цепочки (dispatch -> route -> ответ -> колбэк) завершаются только
// на реальных витках event loop между вызовами. Поэтому чанки + отстой.
async function runVirtual(page, totalMs, stepMs = 15000) {
  let left = totalMs;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    await page.clock.runFor(step);
    await page.waitForTimeout(150);
    left -= step;
  }
}

test('loop fix: status ok + accsdb deny -> success не показывается, гейт остаётся', async ({ page }) => {
  // Гейт с загрузки (accsdb отказывает), tgauth-стор «авторизован» —
  // точное условие бывшего цикла success -> reload -> deny -> гейт.
  await setupPage(page, false);
  statusAuthorized = true;

  await expect(overlay(page)).toBeVisible();
  const t0 = await bootedAt(page);

  // Три тика polling по 10 с: каждый вызывает пробу; success появляться не должен.
  await runVirtual(page, 35000);

  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.tga-ok')).toBeHidden();
  expect(await bootedAt(page)).toBe(t0); // reload не было
  // Стандартное стартовое окно: дефолтный sub, без текста отказа accsdb.
  await expect(overlay(page)).not.toContainText('denied');
  await expect(overlay(page)).toContainText('Безопасно войди');
});

test('heartbeat: отзыв доступа -> гейт сам, без reload', async ({ page }) => {
  await setupPage(page);

  await expect(overlay(page)).toBeHidden();
  const t0 = await bootedAt(page);

  access = false; // серверный отзыв без перезагрузки страницы
  // Два тика heartbeat (60 с ±30% → 42–78 с каждый) + запас на fetch-отстой.
  await runVirtual(page, 210000);

  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.tga-ok')).toBeHidden();
  expect(await bootedAt(page)).toBe(t0);
  // Relock показывает стартовое окно, а не текст отказа accsdb.
  await expect(overlay(page)).not.toContainText('denied');
  await expect(overlay(page)).toContainText('Безопасно войди');
});

test('heartbeat: без отзыва гейт не появляется', async ({ page }) => {
  await setupPage(page);

  await runVirtual(page, 130000);
  await expect(overlay(page)).toBeHidden();
});

test('intercept: сторонний deny + проба deny -> relock', async ({ page }) => {
  await setupPage(page);
  await expect(overlay(page)).toBeHidden();

  access = false; // подтверждающая проба тоже откажет
  await page.evaluate(() => new Promise((res) => window.$.ajax({ url: '/online/lite', success: res })));
  await expect(overlay(page)).toBeVisible();
});

test('intercept: сторонний deny + проба ok -> relock нет', async ({ page }) => {
  await setupPage(page);
  await expect(overlay(page)).toBeHidden();

  access = true; // проба разрешает: это /lifeevents, а не отказ
  await page.evaluate(() => new Promise((res) => window.$.ajax({ url: '/online/lite', success: res })));
  await runVirtual(page, 20000);
  await expect(overlay(page)).toBeHidden();
});
