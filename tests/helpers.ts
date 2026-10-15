import { expect, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

export const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);

/**
 * Kartenkacheln blockieren: Tests sollen nicht vom Kartendienst abhängen.
 * Die App fällt dann auf den Ersatzstil zurück, die Strecke bleibt sichtbar.
 */
export async function blockTiles(page: Page): Promise<void> {
  await page.route(/tiles\.openfreemap\.org/, (route) => route.abort());
}

/** Konsolenfehler sammeln, außer erwartbaren Netzwerkfehlern der blockierten Kacheln. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|openfreemap/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/**
 * Prüft, ob ein Element für den Menschen wirklich sichtbar und antippbar ist:
 * echte Größe, im Bildschirm, und an seinem Mittelpunkt liegt nichts anderes darüber
 * und es wird nicht von einem Eltern-Container weggeschnitten.
 * (toBeVisible() allein reicht nicht – das hat die 0-px-Karte durchgelassen.)
 */
export async function expectOnScreen(locator: Locator, minSize = 8): Promise<void> {
  await expect(locator).toBeVisible();
  // Erreichbar heißt: notfalls im Panel hinscrollen, wie ein Mensch es tun würde
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, 'Element hat keine Größe').not.toBeNull();
  expect(box!.width, 'Element zu schmal').toBeGreaterThanOrEqual(minSize);
  expect(box!.height, 'Element zu niedrig').toBeGreaterThanOrEqual(minSize);
  const vp = locator.page().viewportSize()!;
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  expect(cx >= 0 && cx <= vp.width && cy >= 0 && cy <= vp.height, 'Element liegt außerhalb des Bildschirms').toBe(true);
  const hit = await locator.evaluate(
    (el, [x, y]) => {
      const top = document.elementFromPoint(x, y);
      return !!top && (el === top || el.contains(top));
    },
    [cx, cy] as const,
  );
  expect(hit, 'Element ist verdeckt oder weggeschnitten').toBe(true);
}

/**
 * Zählt auf einem Screenshot die Pixel in der Nähe einer Farbe.
 * So prüfen wir, ob die Strecke wirklich auf der Karte gezeichnet wird.
 */
export async function countColorPixels(
  page: Page,
  hex: string,
  clip?: { x: number; y: number; width: number; height: number },
  tolerance = 40,
): Promise<number> {
  const png = (await page.screenshot({ clip, scale: 'css' })).toString('base64');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return page.evaluate(
    async ({ png, r, g, b, tolerance }) => {
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
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) <= tolerance) n++;
      }
      return n;
    },
    { png, r, g, b, tolerance },
  );
}

export async function openApp(page: Page, hash = ''): Promise<void> {
  await blockTiles(page);
  await page.goto(`/${hash}`);
  await page.locator('body[data-ready="true"]').waitFor();
}
