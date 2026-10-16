import { test, expect } from '@playwright/test';
import { collectErrors, fixture, openApp } from './helpers';

const km = (text: string | null) => parseFloat((text ?? '').replace(/[^\d,]/g, '').replace(',', '.'));

test('Radrennen laden: Startnummer zeigt Name, Art und Länge', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));

  await expect(page.locator('#event-name')).toHaveValue('Heide-Radrennen');
  await expect(page.locator('#event-kind')).toHaveText('Radrennen');
  const total = km(await page.getByTestId('total-distance').textContent());
  expect(total).toBeGreaterThan(37.2);
  expect(total).toBeLessThan(38.2);
  await expect(page.getByTestId('leg')).toHaveCount(1);
  await expect(page.locator('.pin-start')).toBeVisible();
  // Rundkurs: ein gemeinsamer Start/Ziel-Marker statt zwei übereinanderliegender
  await expect(page.locator('.pin')).toHaveCount(1);
  await expect(page.locator('.pin')).toHaveText('Start/Ziel');

  expect(errors).toEqual([]);
});

test('Triathlon aus einer Datei: drei Etappen mit erkannter Disziplin', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));

  await expect(page.locator('#event-kind')).toHaveText('Triathlon');
  const legs = page.getByTestId('leg');
  await expect(legs).toHaveCount(3);
  await expect(legs.nth(0).locator('select')).toHaveValue('schwimmen');
  await expect(legs.nth(1).locator('select')).toHaveValue('rad');
  await expect(legs.nth(2).locator('select')).toHaveValue('lauf');
  const total = km(await page.getByTestId('total-distance').textContent());
  expect(total).toBeGreaterThan(51);
  expect(total).toBeLessThan(52.5);
});

test('Disziplin ändern und Etappe entfernen', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  await page.getByTestId('leg').nth(2).locator('select').selectOption('wechsel');
  await expect(page.getByTestId('leg').nth(2).locator('select')).toHaveValue('wechsel');

  await page.getByRole('button', { name: 'Swim entfernen' }).click();
  await expect(page.getByTestId('leg')).toHaveCount(2);
});

test('Defekte Datei: verständliche Fehlermeldung, nichts geladen', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('kaputt.gpx'));
  await expect(page.locator('#toast')).toContainText('kaputt.gpx');
  await expect(page.getByRole('heading', { name: 'Welches Rennen schaust du?' })).toBeVisible();
});

test('Strecke bleibt nach dem Neuladen erhalten', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await page.locator('#event-name').fill('Mein Rennen');
  await page.locator('#event-name').press('Enter');
  await page.locator('body[data-saved="Mein Rennen"]').waitFor();

  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await expect(page.locator('#event-name')).toHaveValue('Mein Rennen');
  await expect(page.getByTestId('leg')).toHaveCount(1);
});

test('Teilen-Link öffnet dieselbe Strecke auf einem anderen Gerät', async ({ page, browser }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  // Erst warten, bis die Strecke wirklich geladen ist (sonst Wettlauf, v. a. auf WebKit)
  await expect(page.getByTestId('leg')).toHaveCount(3);
  const before = await page.getByTestId('total-distance').textContent();
  expect(before).toMatch(/km/);

  await page.getByRole('button', { name: 'Link teilen' }).click();
  // Link wird asynchron erzeugt (Kompression) → erst warten, bis er da ist
  await expect(page.getByTestId('share-link')).toHaveValue(/#e=[A-Za-z0-9_-]+$/);
  const link = await page.getByTestId('share-link').inputValue();
  expect(link).toMatch(/#e=[A-Za-z0-9_-]+$/);

  // Frisches Gerät ohne gespeicherten Zustand
  const other = await browser.newPage();
  const url = new URL(link);
  await openApp(other, url.hash);
  await expect(other.locator('#event-name')).toHaveValue('Stadt-Triathlon');
  await expect(other.getByTestId('leg')).toHaveCount(3);
  await expect(other.getByTestId('total-distance')).toHaveText(before!);
  // Hash wird nach dem Laden entfernt
  expect(new URL(other.url()).hash).toBe('');
  await other.close();
});

test('Beschädigter Link: Hinweis statt Absturz', async ({ page }) => {
  await openApp(page, '#e=kaputt');
  await expect(page.locator('#toast')).toContainText('beschädigt');
  await expect(page.getByRole('heading', { name: 'Welches Rennen schaust du?' })).toBeVisible();
});

test('Eigener Standort: Abstand zur Strecke wird angezeigt', async ({ browser }) => {
  const context = await browser.newContext({
    geolocation: { latitude: 53.2464, longitude: 10.4115 }, // Mitte der Runde, ~6 km von der Strecke
    permissions: ['geolocation'],
  });
  const page = await context.newPage();
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('where')).toContainText(/Du bist [\d,]+ km von der Strecke entfernt/);
  await context.close();
});
