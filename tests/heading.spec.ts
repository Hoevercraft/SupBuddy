import { test, expect, type Page } from '@playwright/test';
import { chooseHeading, compassHeading, coneHalfAngle, smooth, COMPASS_HOLD_MS, GPS_HOLD_MS } from '../src/heading';
import { fixture, openApp } from './helpers';

/* Blickrichtung (Kegel am eigenen Standort). */

test.describe('Logik', () => {
  test('Kompass: iOS-Wert, Android-alpha, Querformat, ohne Nordbezug', () => {
    expect(compassHeading({ alpha: null, webkitCompassHeading: 90 }, 0)).toBe(90);
    expect(compassHeading({ alpha: 270, absolute: true }, 0)).toBe(90); // alpha zählt gegen den Uhrzeigersinn
    expect(compassHeading({ alpha: 0, absolute: true }, 0)).toBe(0);
    expect(compassHeading({ alpha: 270, absolute: true }, 90)).toBe(180); // Querformat: Oberkante zeigt woanders hin
    expect(compassHeading({ alpha: 120, absolute: false }, 0)).toBeNull(); // relativ → unbrauchbar
    expect(compassHeading({ alpha: null, webkitCompassHeading: -1 }, 0)).toBeNull(); // iOS: ungültig
  });

  test('Glätten dreht über den kürzeren Weg', () => {
    expect(smooth(null, 350)).toBe(350);
    const s = smooth(350, 10, 0.5);
    expect(s).toBe(0); // 350 → 10 über Norden, nicht über Süden
    expect(smooth(10, 350, 0.5)).toBe(0);
  });

  test('GPS-Fahrtrichtung schlägt Kompass, beide veralten', () => {
    const now = 1_000_000;
    const compass = { deg: 40, at: now - 500, accuracy: 10 };
    const gps = { deg: 200, at: now - 1000 };
    expect(chooseHeading({ compass, gps }, now)?.source).toBe('gps');
    expect(chooseHeading({ compass, gps: { ...gps, at: now - GPS_HOLD_MS - 1 } }, now)).toMatchObject({ deg: 40, source: 'kompass' });
    expect(chooseHeading({ compass: { ...compass, at: now - COMPASS_HOLD_MS - 1 }, gps: null }, now)).toBeNull();
  });

  test('Ungenauer Kompass → breiterer Kegel', () => {
    expect(coneHalfAngle(undefined)).toBe(28);
    expect(coneHalfAngle(5)).toBe(20);
    expect(coneHalfAngle(40)).toBe(40);
    expect(coneHalfAngle(90)).toBe(55);
  });
});

const ME = { latitude: 53.27, longitude: 10.45 };

/** Wie auf dem iPhone: Kompass-Erlaubnis wird abgefragt und erteilt; Aufrufe mitzählen. */
async function grantCompass(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __compassAsked: number; DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };
    w.__compassAsked = 0;
    if (w.DeviceOrientationEvent) {
      w.DeviceOrientationEvent.requestPermission = async () => {
        w.__compassAsked++;
        return 'granted';
      };
    }
  });
}

/** Kompass-Ereignis wie vom Gerät (Android: alpha + absolute, iOS: webkitCompassHeading). */
async function compass(page: Page, fields: Record<string, number | boolean>) {
  await page.evaluate((f) => {
    for (const type of ['deviceorientation', 'deviceorientationabsolute']) {
      const e = new Event(type);
      Object.assign(e, { alpha: null, ...f });
      window.dispatchEvent(e);
    }
  }, fields);
}

/** Blaue Kegel-Pixel in einem Feld neben dem Punkt (dx, dy = Richtung). */
async function conePixels(page: Page, dx: number, dy: number): Promise<number> {
  const box = (await page.getByTestId('user-dot').boundingBox())!;
  const cx = box.x + box.width / 2 + dx * 34;
  const cy = box.y + box.height / 2 + dy * 34;
  const png = (await page.screenshot({ clip: { x: cx - 14, y: cy - 14, width: 28, height: 28 }, scale: 'css' })).toString('base64');
  return page.evaluate(async (png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 45) n++; // deutlich blau
    return n;
  }, png);
}

test('Kompass dreht den Kegel am eigenen Standort; ohne Kompass kein Kegel', async ({ browser }, info) => {
  const context = await browser.newContext({ ...info.project.use, geolocation: ME, permissions: ['geolocation'], serviceWorkers: 'block' });
  const page = await context.newPage();
  await grantCompass(page);
  await page.clock.install({ time: new Date('2026-08-23T09:50:00+02:00') });
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);
  // Erlaubnis wurde direkt beim Tippen abgefragt (iOS verlangt das)
  expect(await page.evaluate(() => (window as unknown as { __compassAsked: number }).__compassAsked)).toBe(1);

  // Noch keine Richtung → kein Kegel
  const cone = page.getByTestId('user-cone');
  await expect(cone).toBeHidden();
  await page.clock.runFor(1500);
  await page.waitForTimeout(500);
  const quiet = [await conePixels(page, 1, 0), await conePixels(page, -1, 0)];
  expect(quiet[0] + quiet[1], 'ohne Kompass dürfen keine Kegel-Pixel da sein').toBeLessThan(15);

  // Blick nach Osten (Android-Werte): Kegel rechts vom Punkt, links nichts
  await compass(page, { alpha: 270, absolute: true });
  await expect(cone).toBeVisible();
  await expect(page.getByTestId('user-dot')).toHaveAttribute('data-heading', '90');
  await expect.poll(() => conePixels(page, 1, 0), { timeout: 10_000 }).toBeGreaterThan(150);
  expect(await conePixels(page, -1, 0)).toBeLessThan(15);
  expect(await conePixels(page, 0, -1)).toBeLessThan(15);

  // Blick nach Süden (iOS-Wert): mehrere Werte → der Kegel zieht weich nach
  for (let i = 0; i < 25; i++) await compass(page, { webkitCompassHeading: 180 });
  await expect(page.getByTestId('user-dot')).toHaveAttribute('data-heading', /^(179|180|181)$/);
  await expect.poll(() => conePixels(page, 0, 1), { timeout: 10_000 }).toBeGreaterThan(150);
  expect(await conePixels(page, 1, 0)).toBeLessThan(15);

  // Kompass verstummt → Kegel verschwindet (lieber keiner als ein falscher)
  await page.clock.runFor(COMPASS_HOLD_MS + 1500);
  await expect(cone).toBeHidden();
  await context.close();
});
