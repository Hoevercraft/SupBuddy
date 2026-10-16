import { test, expect } from '@playwright/test';
import { collectErrors, fixture, openApp } from './helpers';

test('App lädt ohne Konsolenfehler und zeigt den Einstieg', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await expect(page).toHaveTitle('SupBuddy');
  await expect(page.getByRole('heading', { name: 'Welches Rennen schaust du?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GPX-Datei laden' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Versionsanzeige: sichtbar unten, mit Commit und Build-Zeit', async ({ page }) => {
  await openApp(page);
  const version = page.getByTestId('version');
  await expect(version).toHaveText(/^v\d+\.\d+\.\d+ · ([0-9a-f]{7}|dev) · \d{2}\.\d{2}\. \d{2}:\d{2}$/);
  // In GitHub Actions muss es genau der gebaute Commit sein
  if (process.env.GITHUB_SHA) await expect(version).toContainText(process.env.GITHUB_SHA.slice(0, 7));

  // Unten im Bild und nicht verdeckt – auch wenn eine Strecke geladen ist
  for (const loaded of [false, true]) {
    if (loaded) {
      await page.locator('#file-input').setInputFiles(fixture('triathlon.gpx'));
      await expect(page.locator('#event-kind')).toHaveText('Triathlon');
      // Ohne offenen Bereich liegt unten die Leiste – die Version muss trotzdem lesbar sein
      await page.getByRole('button', { name: 'Athleten schließen' }).click();
      await expect(page.getByTestId('statusbar')).toBeVisible();
    }
    const vp = page.viewportSize()!;
    const box = (await version.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    expect(box.y).toBeGreaterThan(vp.height * 0.85);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    const onTop = await version.evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.style.pointerEvents = 'auto';
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      el.style.pointerEvents = '';
      return top === el;
    });
    expect(onTop, 'Versionsanzeige ist verdeckt').toBe(true);
  }
});

test('PWA-Manifest ist erreichbar und vollständig', async ({ page, request }) => {
  await openApp(page);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBe('SupBuddy');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test('Service Worker wird registriert', async ({ page }) => {
  await openApp(page);
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(registered).toBe(true);
});

test('App-Icon: gelbe Startnummer mit Megafon (nicht mehr das SUP-Board)', async ({ page }) => {
  await openApp(page);
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href).toMatch(/icon\.svg$/);
  // Alle Icons (Favicon-SVG und die PNGs fürs Handy) zeigen dasselbe Motiv: überwiegend Gelb, dazu Dunkelblau
  for (const file of ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    const share = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, 128, 128);
      const d = ctx.getImageData(0, 0, 128, 128).data;
      let yellow = 0;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - 0xff) + Math.abs(d[i + 1] - 0xd2) + Math.abs(d[i + 2] - 0x3f) < 40) yellow++;
        if (Math.abs(d[i] - 0x14) + Math.abs(d[i + 1] - 0x21) + Math.abs(d[i + 2] - 0x3d) < 40) ink++;
      }
      return { yellow: yellow / (128 * 128), ink: ink / (128 * 128) };
    }, new URL(file, page.url()).toString());
    expect(share.yellow, `${file}: zu wenig Gelb`).toBeGreaterThan(0.55);
    expect(share.ink, `${file}: Megafon fehlt`).toBeGreaterThan(0.08);
  }
});
