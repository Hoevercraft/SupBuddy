import { test, expect, type Page } from '@playwright/test';
import { countColorPixels, expectOnScreen, fixture, openApp } from './helpers';

/*
 * Sichtprüfungen: Was sieht der Mensch auf dem Bildschirm?
 * Diese Tests prüfen nicht, ob Elemente existieren, sondern ob sie
 * wirklich gezeichnet, im Bild und antippbar sind.
 */

const RAD = '#ff8a3d';

/** Bereich der Karte, der nicht von Startnummer oder Panel verdeckt ist. */
async function freeMapArea(page: Page) {
  const vp = page.viewportSize()!;
  const bib = await page.locator('#bib').boundingBox();
  const sheet = await page.locator('#sheet').boundingBox();
  const top = Math.ceil(bib ? bib.y + bib.height : 0) + 4;
  // Auf breiten Bildschirmen liegt das Panel links, nicht unten
  const sheetIsBottom = sheet && sheet.width > vp.width * 0.9;
  const bottom = Math.floor(sheetIsBottom ? sheet!.y : vp.height) - 4;
  const left = !sheetIsBottom && sheet ? Math.ceil(sheet.x + sheet.width) + 4 : 0;
  return { x: left, y: top, width: vp.width - left, height: Math.max(1, bottom - top) };
}

test('Karte füllt den Bildschirm und zeichnet die Strecke', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await expect(page.locator('#event-kind')).toHaveText('Radrennen');

  // Die Karten-Zeichenfläche selbst muss (fast) den ganzen Bildschirm einnehmen
  const vp = page.viewportSize()!;
  const canvas = await page.locator('#map canvas').boundingBox();
  expect(canvas, 'Keine Karten-Zeichenfläche').not.toBeNull();
  expect(canvas!.height).toBeGreaterThan(vp.height * 0.8);
  expect(canvas!.width).toBeGreaterThan(vp.width * 0.8);

  // Und auf dem Bild müssen wirklich orange Streckenpixel zu sehen sein
  await expect
    .poll(async () => countColorPixels(page, RAD, await freeMapArea(page)), {
      message: 'Strecke ist auf der Karte nicht zu sehen',
      timeout: 10_000,
    })
    .toBeGreaterThan(300);
});

test('Ohne Strecke ist auf der Karte nichts Oranges', async ({ page }) => {
  // Gegenprobe, damit der Pixel-Test nicht zufällig grün ist
  await openApp(page);
  await page.waitForTimeout(500);
  expect(await countColorPixels(page, RAD, await freeMapArea(page))).toBeLessThan(20);
});

test('Bedienelemente sind sichtbar und nicht verdeckt', async ({ page }) => {
  await openApp(page);
  await expectOnScreen(page.getByRole('button', { name: 'GPX-Datei laden' }));

  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  await expect(page.getByTestId('leg')).toHaveCount(3);

  await expectOnScreen(page.locator('#event-name'));
  await expectOnScreen(page.getByTestId('total-distance'));
  await expectOnScreen(page.locator('.maplibregl-ctrl-geolocate'), 24);
  await expectOnScreen(page.locator('.pin-start'));
  await expectOnScreen(page.locator('.pin-finish'));
  await expectOnScreen(page.getByRole('button', { name: 'Link teilen' }), 40);
  await expectOnScreen(page.getByRole('button', { name: 'Etappe hinzufügen' }), 40);
  await expectOnScreen(page.getByRole('button', { name: 'Standort anzeigen' }), 40);
  for (const sel of await page.locator('.leg-discipline').all()) await expectOnScreen(sel);
});

test('Screenshot für die Durchsicht', async ({ page }, info) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  await expect(page.getByTestId('leg')).toHaveCount(3);
  await page.waitForTimeout(800);
  await info.attach('triathlon', { body: await page.screenshot(), contentType: 'image/png' });
});
