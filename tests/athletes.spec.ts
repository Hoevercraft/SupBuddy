import { test, expect, type Page } from '@playwright/test';
import { collectErrors, countColorPixels, expectOnScreen, fixture, openApp } from './helpers';

/*
 * Athleten und Zeitplan in der Oberfläche.
 * Die Uhr der Seite wird fest gestellt, damit „laut Plan“ reproduzierbar ist.
 * Radrennen-Fixture: 37,7-km-Runde um Lüneburg, gegen den Uhrzeigersinn ab dem östlichsten Punkt;
 * der nördlichste Punkt (53,3003 / 10,4115) liegt bei km 9,4.
 */

const NORTH = { latitude: 53.3003, longitude: 10.4117 };
const JAN = '#d62839';

async function setClock(page: Page, hhmm: string, date = '2026-08-23') {
  await page.clock.setFixedTime(new Date(`${date}T${hhmm}:00+02:00`));
}

async function addAthlete(page: Page, name: string, start: string, fields: Record<string, string> = {}) {
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const dialog = page.locator('#athlete-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name des Athleten').fill(name);
  await dialog.getByLabel('Startzeit').fill(start);
  for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label).fill(value);
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();
  // Die Meldung erscheint erst, wenn auch gespeichert ist – sonst kann ein Reload den Athleten verlieren
  await expect(page.locator('#toast')).toHaveText(`${name} hinzugefügt.`);
}

test('Radrennen: Athlet anlegen, Position laut Plan und Durchgangszeit bei mir', async ({ browser }) => {
  const context = await browser.newContext({ geolocation: NORTH, permissions: ['geolocation'] });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await setClock(page, '10:10');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));

  await expect(page.getByText('Trag ein, wer startet')).toBeVisible();
  await addAthlete(page, 'Jan', '10:00'); // Standard: 30 km/h
  const row = page.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(row.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 5,0');

  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  // 9,4 km bei 30 km/h = 18,9 min → 10:19
  await expect(row.getByTestId('athlete-here')).toHaveText(/^Bei dir \(km 9,4\): ca\. 10:19 · in 9 min$/);
  await expectOnScreen(row.getByTestId('athlete-here'));
  expect(errors).toEqual([]);
  await context.close();
});

test('Athlet erscheint auf der Karte – nur solange er laut Plan unterwegs ist', async ({ page }) => {
  await setClock(page, '09:50');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00');
  await expect(page.getByTestId('athlete-status')).toHaveText('Start um 10:00 · in 10 min');
  await expect(page.getByTestId('athlete-pin')).toHaveCount(0);

  // Uhr vorstellen und Seite neu laden (Athlet ist gespeichert)
  await setClock(page, '10:10');
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await expect(page.getByTestId('athlete-pin')).toHaveCount(1);

  // Vollbild, damit die ganze Strecke frei sichtbar ist; der rote Marker muss gezeichnet sein
  await page.getByRole('button', { name: 'Vollbild', exact: true }).click();
  const pin = page.getByTestId('athlete-pin');
  await expect(pin).toContainText('Jan');
  const box = (await pin.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x >= 0 && box.y >= 0 && box.x < vp.width && box.y < vp.height, 'Marker außerhalb des Bildes').toBe(true);
  expect(await countColorPixels(page, JAN, { x: 0, y: 0, width: vp.width, height: vp.height })).toBeGreaterThan(200);

  await setClock(page, '12:00');
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await expect(page.getByTestId('athlete-status')).toHaveText(/^Laut Plan im Ziel seit 11:15$/);
  await expect(page.getByTestId('athlete-pin')).toHaveCount(0);
});

test('Triathlon: Pace je Disziplin und Wechselzeit', async ({ page }) => {
  await setClock(page, '10:00');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const dialog = page.locator('#athlete-dialog');
  for (const label of ['Schwimm-Pace in min pro 100 m', 'Rad-Tempo in km/h', 'Lauf-Pace in min pro km', 'Wechselzeit in Minuten']) {
    await expectOnScreen(dialog.getByLabel(label));
  }
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  await addAthlete(page, 'Kumpel Tri', '09:00', {
    'Schwimm-Pace in min pro 100 m': '2:00',
    'Rad-Tempo in km/h': '30',
    'Lauf-Pace in min pro km': '5:30',
    'Wechselzeit in Minuten': '3',
  });
  // 30 min Schwimmen + 3 min Wechsel → Rad ab 09:33; um 10:00 also 13,5 km Rad + 1,5 km Schwimmen
  await expect(page.getByTestId('athlete-status')).toHaveText(/^Laut Plan bei km 1[45],\d \(Rad\)$/);

  await setClock(page, '09:31');
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await expect(page.getByTestId('athlete-status')).toHaveText('Laut Plan im Wechsel nach Schwimmen');
});

test('Eingabefehler werden verständlich gemeldet', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const dialog = page.locator('#athlete-dialog');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.locator('#athlete-error')).toHaveText('Gib einen Namen ein.');

  await dialog.getByLabel('Name des Athleten').fill('Jan');
  await dialog.getByLabel('Lauf-Pace in min pro km').fill('schnell');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.locator('#athlete-error')).toHaveText('Lauf-Pace bitte als Minuten pro km, z. B. 5:30.');
  await expectOnScreen(dialog.locator('#athlete-error'));
  await expect(dialog).toBeVisible();
});

test('Athlet bearbeiten und entfernen', async ({ page }) => {
  await setClock(page, '10:10');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00');
  await addAthlete(page, 'Max', '10:00', { 'Rad-Tempo in km/h': '36' });
  await expect(page.getByTestId('athlete')).toHaveCount(2);
  await expect(page.getByTestId('athlete').nth(1).getByTestId('athlete-status')).toHaveText('Laut Plan bei km 6,0');

  await page.getByRole('button', { name: 'Max bearbeiten' }).click();
  await page.locator('#athlete-dialog').getByLabel('Rad-Tempo in km/h').fill('24');
  await page.locator('#athlete-dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByTestId('athlete').nth(1).getByTestId('athlete-status')).toHaveText('Laut Plan bei km 4,0');

  await page.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await page.getByRole('button', { name: 'Athlet entfernen' }).click();
  await expect(page.getByTestId('athlete')).toHaveCount(1);
  await expect(page.getByTestId('athlete')).toContainText('Max');
});

test('Renntag in der Zukunft', async ({ page }) => {
  await setClock(page, '10:10');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00');
  await page.locator('#race-date').fill('2026-08-30');
  await expect(page.getByTestId('athlete-status')).toHaveText(/^Start am 30\.8\. um 10:00 · in 7 Tage$/);
});

test('Teilen-Link nimmt Athleten, Pace und Renntag mit', async ({ page, browser }) => {
  await setClock(page, '10:10');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00');
  await addAthlete(page, 'Max', '10:00', { 'Rad-Tempo in km/h': '36' });

  await page.getByRole('button', { name: 'Link teilen' }).click();
  // Link wird asynchron erzeugt (Kompression) → erst warten, bis er da ist
  await expect(page.getByTestId('share-link')).toHaveValue(/#e=[A-Za-z0-9_-]+$/);
  const link = await page.getByTestId('share-link').inputValue();

  const other = await browser.newPage();
  await setClock(other, '10:10');
  await openApp(other, new URL(link).hash);
  await expect(other.getByTestId('athlete')).toHaveCount(2);
  await expect(other.locator('#race-date')).toHaveValue('2026-08-23');
  await expect(other.getByTestId('athlete-status')).toHaveText(['Laut Plan bei km 5,0', 'Laut Plan bei km 6,0']);
  await other.close();
});

test('„Standort anzeigen“ zeigt mich und die Athleten im freien Kartenbereich', async ({ browser }) => {
  const context = await browser.newContext({ geolocation: NORTH, permissions: ['geolocation'] });
  const page = await context.newPage();
  await setClock(page, '10:10');
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00'); // km 5,0
  await addAthlete(page, 'Max', '09:55', { 'Rad-Tempo in km/h': '34' }); // km 8,5

  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);
  await page.waitForTimeout(1200); // Kamerafahrt abwarten

  // Frei sichtbarer Bereich: unter der Startnummer, über dem Panel
  const bib = (await page.locator('#bib').boundingBox())!;
  const sheet = (await page.locator('#sheet').boundingBox())!;
  const vp = page.viewportSize()!;
  const top = bib.y + bib.height;
  const bottom = sheet.width > vp.width * 0.9 ? sheet.y : vp.height;
  const left = sheet.width > vp.width * 0.9 ? 0 : sheet.x + sheet.width;
  const inside = async (name: string, loc: ReturnType<typeof page.locator>) => {
    const b = (await loc.boundingBox())!;
    const cx = b.x + Math.min(b.width, 28) / 2; // Mittelpunkt des Punkts (bei Athleten links)
    const cy = b.y + b.height / 2;
    expect(cy > top && cy < bottom && cx > left && cx < vp.width, `${name} nicht im freien Kartenbereich`).toBe(true);
  };
  await inside('Eigener Standort', page.getByTestId('user-dot'));
  for (const pin of await page.getByTestId('athlete-pin').all()) await inside('Athlet', pin);
  await context.close();
});
