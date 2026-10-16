import { test, expect, type Page } from '@playwright/test';
import { countColorPixels, expectOnScreen, fixture, openApp, openSection } from './helpers';

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
  let pixels = 0;
  try {
    await expect
      .poll(async () => (pixels = await countColorPixels(page, RAD, await freeMapArea(page))), { timeout: 10_000 })
      .toBeGreaterThan(300);
  } catch {
    const state = await page.evaluate(() => (window as unknown as { __supbuddyMap?: () => unknown }).__supbuddyMap?.());
    throw new Error(`Strecke ist auf der Karte nicht zu sehen (${pixels} Pixel). Kartenzustand: ${JSON.stringify(state)}`);
  }
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
  // Nach dem Laden ist „Athleten“ offen (nächster Schritt)
  await expect(page.getByTestId('section-title')).toHaveText('Athleten');
  await expectOnScreen(page.getByRole('button', { name: 'Standort anzeigen' }), 40);
  await expectOnScreen(page.getByRole('button', { name: 'Athlet hinzufügen' }), 40);
  for (const label of ['Athleten', 'Anfeuer-Plan', 'Strecke']) await expectOnScreen(page.locator(`.ctrl-section-btn[aria-label="${label}"]`), 24);
  await expectOnScreen(page.locator('#event-name'));
  await expectOnScreen(page.getByTestId('total-distance'));
  await expectOnScreen(page.locator('.maplibregl-ctrl-geolocate'), 24);
  // Quellenhinweis der Karte (OpenStreetMap) muss sichtbar sein
  await expectOnScreen(page.locator('.maplibregl-ctrl-attrib'), 16);
  // Strecke wird über dem offenen Bereich eingepasst: Start und Ziel frei sichtbar
  await expectOnScreen(page.locator('.pin-start'));
  await expectOnScreen(page.locator('.pin-finish'));
  await openSection(page, 'Strecke');
  await expect(page.getByTestId('leg')).toHaveCount(3);
  await expectOnScreen(page.getByRole('button', { name: 'Link teilen' }), 40);
  await expectOnScreen(page.getByRole('button', { name: 'Etappe hinzufügen' }), 40);
  for (const sel of await page.locator('.leg-discipline').all()) await expectOnScreen(sel);
});

test('Screenshot für die Durchsicht', async ({ page }, info) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  await openSection(page, 'Strecke');
  await expect(page.getByTestId('leg')).toHaveCount(3);
  await page.waitForTimeout(800);
  await info.attach('triathlon', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Startnummer ist kompakt und überlappt die Kartenknöpfe nicht', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await expect(page.locator('#event-kind')).toHaveText('Radrennen');
  const bib = (await page.locator('#bib').boundingBox())!;
  expect(bib.height, 'Startnummer zu hoch').toBeLessThanOrEqual(70);
  for (const sel of ['.maplibregl-ctrl-geolocate', '.ctrl-maponly-btn', '.maplibregl-ctrl-attrib']) {
    const c = (await page.locator(sel).boundingBox())!;
    const overlap = c.x < bib.x + bib.width && c.x + c.width > bib.x && c.y < bib.y + bib.height && c.y + c.height > bib.y;
    expect(overlap, `${sel} überlappt die Startnummer`).toBe(false);
  }
});

test('Vollbild: ein Knopf blendet Startnummer und Panel aus und wieder ein', async ({ page }) => {
  await openApp(page);
  // Ohne Strecke gibt es nichts zu zeigen → kein Vollbild-Knopf
  await expect(page.getByRole('button', { name: 'Vollbild' })).toBeHidden();

  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await expect(page.locator('#event-kind')).toHaveText('Radrennen');

  await page.getByRole('button', { name: 'Vollbild', exact: true }).click();
  await expect(page.locator('#bib')).toBeHidden();
  await expect(page.locator('#sheet')).toBeHidden();
  const exit = page.getByRole('button', { name: 'Vollbild beenden' });
  await expect(exit).toHaveAttribute('aria-pressed', 'true');
  await expectOnScreen(exit, 24);
  await expectOnScreen(page.locator('.maplibregl-ctrl-geolocate'), 24);
  await expect(page.getByTestId('version')).toBeVisible();

  // Strecke ist jetzt über die ganze Fläche sichtbar
  const vp = page.viewportSize()!;
  await expect
    .poll(async () => countColorPixels(page, RAD, { x: 0, y: 0, width: vp.width, height: vp.height }), { timeout: 10_000 })
    .toBeGreaterThan(300);

  await exit.click();
  await expect(page.locator('#bib')).toBeVisible();
  await openSection(page, 'Strecke');
  await expectOnScreen(page.getByRole('button', { name: 'Link teilen' }), 40);
  await expect(page.getByRole('button', { name: 'Vollbild', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('Kartenhinweis startet eingeklappt und lässt sich aufklappen', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await expect(page.locator('#event-kind')).toHaveText('Radrennen');
  await page.waitForTimeout(1500); // Karte fertig laden lassen
  const attrib = page.locator('.maplibregl-ctrl-attrib');
  const closed = (await attrib.boundingBox())!;
  expect(closed.width, 'Quellenhinweis ist ausgeklappt und verdeckt die Karte').toBeLessThanOrEqual(40);
  await attrib.locator('.maplibregl-ctrl-attrib-button').click();
  await expect(attrib).toContainText('OpenStreetMap');
  expect((await attrib.boundingBox())!.width).toBeGreaterThan(100);
});
