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
  // Mehrfach versuchen: wird das Element zwischendurch neu aufgebaut, zählt der nächste Stand
  for (let attempt = 1; ; attempt++) {
    try {
      return await checkOnScreen(locator, minSize);
    } catch (e) {
      if (attempt >= 3 || !/not attached|detached/i.test(String(e))) throw e;
    }
  }
}

async function checkOnScreen(locator: Locator, minSize: number): Promise<void> {
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

/**
 * BRouter-Attrappe: gerader Weg von A nach B, Länge = Luftlinie × factor.
 * Gibt die Liste der angefragten URLs zurück (zum Prüfen von Profil und Sperrlinien).
 */
export async function mockRouting(page: Page, factor = 1.3, status = 200): Promise<string[]> {
  const urls: string[] = [];
  await page.route(/brouter\.de\/brouter/, async (route) => {
    const url = route.request().url();
    urls.push(url);
    if (status !== 200) return route.fulfill({ status, body: 'down' });
    const lonlats = new URL(url).searchParams.get('lonlats')!.split('|').map((p) => p.split(',').map(Number));
    const [[lng1, lat1], [lng2, lat2]] = lonlats;
    const R = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const h =
      Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    const dist = 2 * R * Math.asin(Math.sqrt(h)) * factor;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { 'track-length': String(Math.round(dist)), 'total-time': '0' },
            geometry: { type: 'LineString', coordinates: [[lng1, lat1, 0], [(lng1 + lng2) / 2, (lat1 + lat2) / 2 + 0.002, 0], [lng2, lat2, 0]] },
          },
        ],
      }),
    });
  });
  return urls;
}

/** Polyline kodieren (Gegenstück zu decodePolyline), Genauigkeit 7 wie bei MOTIS. */
export function encodePolyline(points: { lat: number; lng: number }[], precision = 7): string {
  const f = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * f);
    const lng = Math.round(p.lng * f);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

/**
 * Transitous-Attrappe: 5 min Fußweg zur Haltestelle, Bus mit `kmh` (Abfahrt alle 10 min),
 * 5 min Fußweg zum Ziel. Haltestellen-IDs im DELFI-Format mit Kreis `kreis`.
 * Beachtet time/arriveBy wie der echte Dienst. Gibt die angefragten URLs zurück.
 */
export async function mockTransit(page: Page, opts: { kmh?: number; kreis?: string; status?: number } = {}): Promise<string[]> {
  const { kmh = 40, kreis = '03355', status = 200 } = opts;
  const urls: string[] = [];
  await page.route(/api\.transitous\.org\/api\/v1\/plan/, async (route) => {
    const url = new URL(route.request().url());
    urls.push(url.toString());
    if (status !== 200) return route.fulfill({ status, body: 'down' });
    const [lat1, lng1] = url.searchParams.get('fromPlace')!.split(',').map(Number);
    const [lat2, lng2] = url.searchParams.get('toPlace')!.split(',').map(Number);
    const time = Date.parse(url.searchParams.get('time')!);
    const arriveBy = url.searchParams.get('arriveBy') === 'true';
    const R = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    const dist = 2 * R * Math.asin(Math.sqrt(h));
    const WALK = 5 * 60_000;
    const ride = Math.max(4 * 60_000, Math.round(((dist * 1.2) / (kmh / 3.6)) * 1000 / 60_000) * 60_000);
    const A = { lat: lat1 + (lat2 - lat1) * 0.05, lng: lng1 + (lng2 - lng1) * 0.05 };
    const B = { lat: lat1 + (lat2 - lat1) * 0.95, lng: lng1 + (lng2 - lng1) * 0.95 };
    const SLOT = 10 * 60_000;
    // Abfahrten des Busses
    const deps: number[] = [];
    if (arriveBy) {
      let d = Math.floor((time - WALK - ride) / SLOT) * SLOT;
      for (let i = 0; i < 3; i++, d -= SLOT) deps.push(d);
    } else {
      let d = Math.ceil((time + WALK) / SLOT) * SLOT;
      for (let i = 0; i < 3; i++, d += SLOT) deps.push(d);
    }
    const iso = (t: number) => new Date(t).toISOString();
    const geo = (pts: { lat: number; lng: number }[]) => ({ points: encodePolyline(pts), precision: 7, length: pts.length });
    const stopA = { name: 'Haltestelle Start', stopId: `de-DELFI_de:${kreis}:100::1`, lat: A.lat, lon: A.lng };
    const stopB = { name: 'Haltestelle Ziel', stopId: `de-DELFI_de:${kreis}:200::2`, lat: B.lat, lon: B.lng };
    const itineraries = deps.map((dep) => ({
      startTime: iso(dep - WALK),
      endTime: iso(dep + ride + WALK),
      duration: (WALK * 2 + ride) / 1000,
      transfers: 0,
      legs: [
        { mode: 'WALK', from: { name: 'START', departure: iso(dep - WALK) }, to: { ...stopA, arrival: iso(dep) }, startTime: iso(dep - WALK), endTime: iso(dep), legGeometry: geo([{ lat: lat1, lng: lng1 }, A]) },
        { mode: 'BUS', routeShortName: '5009', headsign: 'Ziel', from: { ...stopA, departure: iso(dep) }, to: { ...stopB, arrival: iso(dep + ride) }, startTime: iso(dep), endTime: iso(dep + ride), legGeometry: geo([A, B]) },
        { mode: 'WALK', from: { ...stopB, departure: iso(dep + ride) }, to: { name: 'END', arrival: iso(dep + ride + WALK) }, startTime: iso(dep + ride), endTime: iso(dep + ride + WALK), legGeometry: geo([B, { lat: lat2, lng: lng2 }]) },
      ],
    }));
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ itineraries, direct: [] }) });
  });
  return urls;
}

/** Bereich über die Icons rechts öffnen (falls noch nicht offen). */
export async function openSection(page: Page, label: 'Athleten' | 'Anfeuer-Plan' | 'Strecke'): Promise<void> {
  const b = page.locator(`.ctrl-section-btn[aria-label="${label}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await expect(page.getByTestId('section-title')).toHaveText(label);
}
