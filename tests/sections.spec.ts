import { test, expect } from '@playwright/test';
import { expectOnScreen, fixture, openApp, openSection } from './helpers';

/*
 * Bereiche über Icons rechts (Athleten, Anfeuer-Plan, Strecke) statt eines langen Panels;
 * unten eine schmale Leiste: wo sind die Athleten, wann bei mir.
 */

const NORTH = { latitude: 53.3003, longitude: 10.4117 }; // an der Strecke bei km 9,4

test('Icons öffnen je einen Bereich, zweiter Tipp oder × schließt; Leiste unten zeigt die Athleten', async ({ browser }, info) => {
  test.slow();
  const ctx = await browser.newContext({ ...info.project.use, geolocation: NORTH, permissions: ['geolocation'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-08-23T10:10:00+02:00'));
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));

  // Nach dem Laden: „Athleten“ offen (nächster Schritt), Icon gedrückt, keine Leiste
  const icon = (label: string) => page.locator(`.ctrl-section-btn[aria-label="${label}"]`);
  await expect(page.getByTestId('section-title')).toHaveText('Athleten');
  await expect(icon('Athleten')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('statusbar')).toBeHidden();

  // × schließt → nur Karte und Leiste
  await page.getByRole('button', { name: 'Athleten schließen' }).click();
  await expect(page.locator('#sheet')).toBeHidden();
  await expect(icon('Athleten')).toHaveAttribute('aria-pressed', 'false');
  const bar = page.getByTestId('statusbar');
  await expect(bar).toContainText('Noch keine Athleten');
  await expectOnScreen(bar, 30);

  // Tipp auf die Leiste öffnet „Athleten“
  await bar.click();
  await expect(page.getByTestId('section-title')).toHaveText('Athleten');
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = page.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill('Jan');
  await d.getByLabel('Startzeit').fill('10:00');
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#toast')).toHaveText('Jan hinzugefügt.');
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);

  // Nur ein Bereich zur Zeit: Plan-Icon wechselt den Inhalt
  await icon('Anfeuer-Plan').click();
  await expect(page.getByTestId('section-title')).toHaveText('Anfeuer-Plan');
  await expect(icon('Anfeuer-Plan')).toHaveAttribute('aria-pressed', 'true');
  await expect(icon('Athleten')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Plan erstellen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Athlet hinzufügen' })).toHaveCount(0);
  await openSection(page, 'Strecke');
  await expect(page.getByRole('button', { name: 'Link teilen' })).toBeVisible();

  // Zweiter Tipp aufs gleiche Icon schließt
  await icon('Strecke').click();
  await expect(page.locator('#sheet')).toBeHidden();

  // Leiste: km laut Plan und wann bei mir (9,4 km bei 30 km/h → 10:19, also in 9 min)
  await expect(bar).toBeVisible();
  await expect(bar.locator('li')).toHaveCount(1);
  await expect(bar.locator('li')).toHaveText(/^JAJan\s*km 5,0 · bei dir in[\s\u00a0]9[\s\u00a0]min$/);
  await expectOnScreen(bar.locator('.status-text'), 8);

  // Leiste und Icons überlappen nicht
  const b = (await bar.boundingBox())!;
  for (const label of ['Athleten', 'Anfeuer-Plan', 'Strecke']) {
    const c = (await icon(label).boundingBox())!;
    expect(c.y + c.height <= b.y || c.x + c.width <= b.x || c.x >= b.x + b.width, `${label} liegt unter der Leiste`).toBe(true);
  }

  // Vollbild blendet die Leiste aus, ein Bereichs-Icon beendet das Vollbild
  await page.getByRole('button', { name: 'Vollbild', exact: true }).click();
  await expect(bar).toBeHidden();
  await icon('Athleten').click();
  await expect(page.getByRole('button', { name: 'Vollbild', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('section-title')).toHaveText('Athleten');
  await ctx.close();
});

test('Ohne Strecke keine Bereichs-Icons und keine Leiste', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.ctrl-section-btn').first()).toBeHidden();
  await expect(page.getByTestId('statusbar')).toBeHidden();
  await expect(page.getByRole('button', { name: 'GPX-Datei laden' })).toBeVisible();
});
