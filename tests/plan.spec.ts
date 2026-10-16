import { test, expect, type Page } from '@playwright/test';
import { countColorPixels, expectOnScreen, fixture, mockRouting, openApp } from './helpers';

/*
 * Anfeuer-Plan in der Oberfläche. Routing (BRouter) wird durch eine Attrappe ersetzt,
 * die Uhr steht fest. Radrennen-Fixture: 37,7-km-Runde um Lüneburg.
 */

const INSIDE_EAST = { latitude: 53.27, longitude: 10.45 }; // innerhalb der Runde, ~3 km von der Strecke
const PLAN_COLOR = '#312e81'; // = PLAN_COLOR in src/map.ts

async function setClock(page: Page, hhmm: string) {
  await page.clock.setFixedTime(new Date(`2026-08-23T${hhmm}:00+02:00`));
}

async function addAthlete(page: Page, name: string, start: string, kmh: string) {
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = page.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill(name);
  await d.getByLabel('Startzeit').fill(start);
  await d.getByLabel('Rad-Tempo in km/h').fill(kmh);
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#toast')).toHaveText(`${name} hinzugefügt.`);
}

async function setup(page: Page) {
  await setClock(page, '09:50');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00', '30');
  await addAthlete(page, 'Max', '10:05', '32');
}

async function makePlan(page: Page) {
  const before = await page.evaluate(() => document.body.dataset.planned ?? '');
  await page.getByRole('button', { name: 'Plan erstellen' }).click();
  await page.waitForFunction((b) => (document.body.dataset.planned ?? '') !== b, before);
}

test('Rad-Plan ab meinem Standort: Stopps mit Zeiten aller Athleten, Wege ohne Strecke zu queren', async ({ browser }) => {
  test.slow(); // langer Ablauf: zwei Athleten, Standort, Plan, Vollbild
  const context = await browser.newContext({ geolocation: INSIDE_EAST, permissions: ['geolocation'] });
  const page = await context.newPage();
  const urls = await mockRouting(page);
  await setup(page);
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);

  await page.getByRole('button', { name: 'Rad', exact: true }).click();
  await expect(page.getByLabel('Dein Tempo in km/h')).toHaveValue('15');
  await expect(page.getByText('Startpunkt: dein Standort.')).toBeVisible();
  await makePlan(page);

  const stops = page.getByTestId('stop');
  const n = await stops.count();
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(3);
  await expect(page.getByTestId('plan-summary')).toContainText(`Jan ${n}× anfeuern`);
  await expect(page.locator('.badge-tight')).toHaveCount(0);
  await expect(page.getByTestId('plan-estimated')).toHaveCount(0);
  // An jedem Stopp: Jan (Plan) und Max mit Abstand
  for (const s of await stops.all()) {
    await expect(s.locator('.stop-athletes li')).toHaveCount(2);
    await expect(s.locator('.stop-athletes li.main')).toContainText(/^Jan ca\. \d\d:\d\d$/);
    await expect(s.locator('.stop-athletes li').nth(1)).toContainText(/^Max (ca\. \d\d:\d\d · (gleichzeitig|\d+\u00a0min\u00a0(später|früher))|schon vorbei)/);
  }
  await expectOnScreen(stops.first().getByRole('button', { name: 'Weg zeigen' }), 30);

  // Routing: Fahrrad-Profil, Strecke als Sperre
  expect(urls.length).toBe(n);
  for (const u of urls) {
    expect(u).toContain('profile=trekking');
    expect(u).toContain('&polylines=');
  }

  // Karte: nummerierte Stopps im Bild, Wege gezeichnet
  await expect(page.getByTestId('stop-pin')).toHaveCount(n);
  await page.getByRole('button', { name: 'Vollbild', exact: true }).click();
  const vp = page.viewportSize()!;
  for (const pin of await page.getByTestId('stop-pin').all()) {
    const b = (await pin.boundingBox())!;
    expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width && b.y + b.height <= vp.height, 'Stopp außerhalb des Bildes').toBe(true);
  }
  await expect
    .poll(() => countColorPixels(page, PLAN_COLOR, { x: 0, y: 80, width: vp.width, height: vp.height - 120 }, 30), { timeout: 10_000 })
    .toBeGreaterThan(150);
  await context.close();
});

test('Navigation öffnet die passende Karten-App mit dem Stopp als Ziel', async ({ page, browserName }) => {
  await mockRouting(page);
  await setup(page);
  await page.getByRole('button', { name: 'E-Scooter' }).click();
  await expect(page.getByLabel('Dein Tempo in km/h')).toHaveValue('18');
  await makePlan(page);
  const href = (await page.getByTestId('stop-nav').first().getAttribute('href'))!;
  const ua = await page.evaluate(() => navigator.userAgent);
  if (/iPhone/.test(ua)) expect(href).toMatch(/^https:\/\/maps\.apple\.com\/\?daddr=5\d\.\d{6},10\.\d{6}$/);
  else expect(href).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=5\d\.\d{6},10\.\d{6}&travelmode=bicycling$/);
  expect(browserName).toBeTruthy();
});

test('Zu Fuß von weit weg: verständlicher Hinweis statt leerem Plan', async ({ browser }) => {
  const context = await browser.newContext({ geolocation: { latitude: 53.2464, longitude: 10.4115 }, permissions: ['geolocation'] });
  const page = await context.newPage();
  await mockRouting(page);
  await setup(page);
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);
  await setClock(page, '10:40'); // Jan ist schon über der Hälfte
  await makePlan(page);
  await expect(page.getByTestId('plan-empty')).toHaveText(
    'Von hier aus bist du nirgends mehr rechtzeitig vor Jan an der Strecke. Probier es mit Rad oder E-Scooter.',
  );
  await expect(page.getByTestId('stop-pin')).toHaveCount(0);
  await context.close();
});

test('Routing nicht erreichbar: Plan mit geschätzten Wegen und Hinweis', async ({ page }) => {
  await mockRouting(page, 1.3, 503);
  await setup(page);
  await page.getByRole('button', { name: 'Rad', exact: true }).click();
  await makePlan(page);
  await expect(page.getByTestId('plan-estimated')).toBeVisible();
  await expect(page.getByTestId('stop').first()).toContainText('(geschätzt)');
});

test('Plan für einen anderen Athleten, Einstellungen bleiben erhalten', async ({ page }) => {
  await mockRouting(page);
  await setup(page);
  await page.getByRole('button', { name: 'Rad', exact: true }).click();
  await page.getByLabel('Plan für Athlet').selectOption({ label: 'Max' });
  await page.getByLabel('Wunschanzahl Stopps').selectOption('2');
  await makePlan(page);
  await expect(page.getByTestId('plan-summary')).toContainText('Max ');
  await expect(page.getByTestId('stop').first().locator('li.main')).toContainText('Max');

  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await expect(page.getByLabel('Plan für Athlet')).toHaveValue('1');
  await expect(page.getByLabel('Wunschanzahl Stopps')).toHaveValue('2');
  await expect(page.getByRole('button', { name: 'Rad', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('Ändern eines Athleten verwirft den alten Plan', async ({ page }) => {
  await mockRouting(page);
  await setup(page);
  await page.getByRole('button', { name: 'Rad', exact: true }).click();
  await makePlan(page);
  await expect(page.getByTestId('plan')).toBeVisible();
  await page.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await page.locator('#athlete-dialog').getByLabel('Startzeit').fill('10:30');
  await page.locator('#athlete-dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByTestId('plan')).toHaveCount(0);
  await expect(page.getByTestId('stop-pin')).toHaveCount(0);
});

test('Ohne Athleten: Hinweis statt Plan-Einstellungen', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await expect(page.getByText('Trag erst einen Athleten ein.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan erstellen' })).toHaveCount(0);
});
