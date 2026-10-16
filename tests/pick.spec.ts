import { test, expect, type Page } from '@playwright/test';
import { countColorPixels, expectOnScreen, fixture, mockRouting, openApp } from './helpers';

/*
 * Auf die Strecke tippen: Karte am Punkt mit Durchgangszeiten, „Weg hierhin“ mit Urteil
 * (rechtzeitig / zu spät), Weg auf der Karte, Navi-Link. Routing ist eine Attrappe.
 */

test.use({ serviceWorkers: 'block' });

const INSIDE_EAST = { latitude: 53.27, longitude: 10.45 }; // innerhalb der Runde, ~3 km von der Strecke
const PLAN_COLOR = '#312e81';

type MapState = { courseScreen: number[][]; pickRoutes: number; pickOpen: boolean; pickScreen?: number[][] };
const mapState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __supbuddyMap: () => unknown }).__supbuddyMap()) as Promise<MapState>;

async function addAthlete(page: Page, name: string, start: string, kmh: string) {
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = page.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill(name);
  await d.getByLabel('Startzeit').fill(start);
  await d.getByLabel('Rad-Tempo in km/h').fill(kmh);
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#toast')).toHaveText(`${name} hinzugefügt.`);
}

async function setup(page: Page, starts = ['10:00', '10:05']) {
  await page.clock.setFixedTime(new Date('2026-08-23T09:50:00+02:00'));
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', starts[0], '30');
  await addAthlete(page, 'Max', starts[1], '32');
}

/** Ein Streckenpunkt, der frei auf der Karte liegt (nichts darüber), möglichst weit weg von den Rändern. */
async function freeCoursePoint(page: Page): Promise<[number, number]> {
  let pick: [number, number] | null = null;
  await expect
    .poll(
      async () => {
        const { courseScreen } = await mapState(page);
        pick = await page.evaluate((pts) => {
          const w = window.innerWidth;
          const ok = pts.filter(([x, y]) => {
            if (x < 40 || x > w - 70 || y < 40) return false;
            const el = document.elementFromPoint(x, y);
            return !!el && el.classList.contains('maplibregl-canvas');
          });
          // Mitte der freien Punkte: weg von Panel und Rand
          ok.sort((a, b) => a[1] - b[1]);
          return (ok[Math.floor(ok.length / 2)] as [number, number]) ?? null;
        }, courseScreen);
        return pick;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
  return pick!;
}

/** Ein freier Kartenpunkt mit Abstand ≥ 80 px zur Strecke. */
async function freeOffCoursePoint(page: Page): Promise<[number, number]> {
  const { courseScreen } = await mapState(page);
  const p = await page.evaluate((pts) => {
    const segDist = (x: number, y: number, a: number[], b: number[]) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = dx * dx + dy * dy;
      const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l));
      return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
    };
    for (let y = 60; y < window.innerHeight; y += 20) {
      for (let x = 40; x < window.innerWidth - 70; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (!el || !el.classList.contains('maplibregl-canvas')) continue;
        let min = Infinity;
        for (let i = 1; i < pts.length; i++) min = Math.min(min, segDist(x, y, pts[i - 1], pts[i]));
        if (min >= 80) return [x, y] as [number, number];
      }
    }
    return null;
  }, courseScreen);
  expect(p, 'kein freier Punkt neben der Strecke').not.toBeNull();
  return p!;
}

async function tap(page: Page, [x, y]: [number, number]) {
  if (test.info().project.use.hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Wie duration() in der App: „45 min“ bzw. „1 h 05 min“. */
const dur = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`);

const clockMin = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

test('Strecke antippen → Zeiten am Punkt, Weg hierhin mit Urteil, Weg auf der Karte, Schließen räumt auf', async ({ browser }, info) => {
  test.slow();
  const context = await browser.newContext({
    ...info.project.use,
    geolocation: INSIDE_EAST,
    permissions: ['geolocation'],
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const urls = await mockRouting(page);
  await setup(page);

  // Dezenter Hinweis im Panel
  await expect(page.getByTestId('pick-tip')).toContainText('Tippe auf die Strecke');

  await tap(page, await freeCoursePoint(page));
  const pop = page.getByTestId('pick');
  await expect(pop).toBeVisible();
  await expect(page.getByTestId('pick-title')).toHaveText(/^(km \d+(,\d)?|Start|Ziel)$/);
  const lis = pop.locator('.pick-athletes li');
  await expect(lis).toHaveCount(2);
  await expect(lis.nth(0)).toHaveText(/^Jan ca\. \d\d:\d\d$/);
  await expect(lis.nth(1)).toHaveText(/^Max ca\. \d\d:\d\d$/);
  // Noch kein Standort → Knopf holt ihn
  const go = page.getByTestId('pick-go');
  await expect(go).toHaveText('Standort holen & Weg zeigen');
  await expectOnScreen(go, 20);
  await go.click();

  // Weg da: Länge, Dauer, Ankunft
  const way = page.getByTestId('pick-way');
  await expect(way).toHaveText(/^[\d,.]+\s(km|m) zu Fuß · ca\. .+ · an ca\. \d\d:\d\d$/, { timeout: 20_000 });
  await expect(go).toHaveCount(0);
  expect(urls.some((u) => u.includes('profile=shortest'))).toBe(true);

  // Urteil passt zu den angezeigten Uhrzeiten
  const arrive = clockMin((await way.textContent())!.match(/an ca\. (\d\d:\d\d)/)![1]);
  for (const li of await lis.all()) {
    const text = (await li.textContent())!;
    const pass = clockMin(text.match(/ca\. (\d\d:\d\d)/)![1]);
    if (pass >= arrive) {
      const diff = pass - arrive;
      expect(text).toContain(diff === 0 ? 'du bist gerade so da ✓' : `du bist ${dur(diff)} vorher da ✓`);
    } else {
      expect(text).toContain(`${dur(arrive - pass)} zu spät`);
    }
  }
  // Rechnung prüfen: 09:50 + Weglänge / 4,5 km/h
  const wayText = (await way.textContent())!;
  const m = wayText.match(/^([\d,.]+)\s(km|m)/)!;
  const meters = parseFloat(m[1].replace('.', '').replace(',', '.')) * (m[2] === 'km' ? 1000 : 1);
  expect(Math.abs(arrive - (9 * 60 + 50 + (meters / 4500) * 60))).toBeLessThanOrEqual(2);

  // Navi-Link zum angetippten Punkt
  const nav = page.getByTestId('pick-nav');
  await expectOnScreen(nav, 20);
  expect(await nav.getAttribute('href')).toMatch(/travelmode=walking|mode=walking/);

  // Weg wirklich gezeichnet (keine Plan-Wege vorhanden → Farbe stammt vom Tipp-Weg)
  const vp = page.viewportSize()!;
  await expect.poll(async () => (await mapState(page)).pickRoutes).toBe(1);
  await expect
    .poll(async () => countColorPixels(page, PLAN_COLOR, { x: 0, y: 0, width: vp.width, height: vp.height }, 45), { timeout: 25_000 })
    .toBeGreaterThan(60);

  // Schließen: Karte und Weg weg
  await page.locator('.pick-popup .maplibregl-popup-close-button').click();
  await expect(pop).toHaveCount(0);
  await expect.poll(async () => (await mapState(page)).pickRoutes).toBe(0);
  await expect
    .poll(async () => countColorPixels(page, PLAN_COLOR, { x: 0, y: 0, width: vp.width, height: vp.height }, 45), { timeout: 10_000 })
    .toBeLessThan(15);
  await context.close();
});

test('Verkehrsmittel in der Punkt-Karte umschalten plant den Weg neu (und gilt auch für den Plan)', async ({ browser }, info) => {
  test.slow();
  const context = await browser.newContext({
    ...info.project.use,
    geolocation: INSIDE_EAST,
    permissions: ['geolocation'],
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const urls = await mockRouting(page);
  await setup(page);
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);
  await page.waitForTimeout(800); // Kamerafahrt zum Standort abwarten

  await tap(page, await freeCoursePoint(page));
  await expect(page.getByTestId('pick-go')).toHaveText('Weg hierhin');
  await page.getByTestId('pick-go').click();
  const way = page.getByTestId('pick-way');
  await expect(way).toContainText('zu Fuß', { timeout: 20_000 });
  const walk = (await way.textContent())!;

  const before = urls.length;
  await page.getByTestId('pick').getByRole('button', { name: 'Rad', exact: true }).click();
  await expect(way).toContainText('mit dem Rad', { timeout: 20_000 });
  expect(urls.slice(before).some((u) => u.includes('profile=trekking'))).toBe(true);
  // Gleicher Weg, schneller → Dauer kürzer
  const travel = (s: string) => {
    const t = s.match(/ca\. ((\d+) h )?(\d+) min/)!;
    return Number(t[2] ?? 0) * 60 + Number(t[3]);
  };
  expect(travel((await way.textContent())!)).toBeLessThan(travel(walk));
  // Plan-Bereich übernimmt das Verkehrsmittel
  await expect(page.locator('#sheet [data-mode="rad"]')).toHaveAttribute('aria-pressed', 'true');
  await context.close();
});

test('Tipp neben die Strecke öffnet nichts und schließt eine offene Punkt-Karte', async ({ page }) => {
  await setup(page);
  await tap(page, await freeOffCoursePoint(page));
  await page.waitForTimeout(300);
  await expect(page.getByTestId('pick')).toHaveCount(0);

  await tap(page, await freeCoursePoint(page));
  await expect(page.getByTestId('pick')).toBeVisible();
  await tap(page, await freeOffCoursePoint(page));
  await expect(page.getByTestId('pick')).toHaveCount(0);
  expect((await mapState(page)).pickOpen).toBe(false);
});

test('Rechtzeitig erreichbar: Urteil „vorher da ✓“ mit der richtigen Minutenzahl', async ({ browser }, info) => {
  test.slow();
  const context = await browser.newContext({ ...info.project.use, geolocation: INSIDE_EAST, permissions: ['geolocation'], serviceWorkers: 'block' });
  const page = await context.newPage();
  await mockRouting(page);
  await setup(page, ['12:30', '12:35']); // Start erst in 2,5 h → überall rechtzeitig zu Fuß
  await tap(page, await freeCoursePoint(page));
  await page.getByTestId('pick-go').click();
  const way = page.getByTestId('pick-way');
  await expect(way).toContainText('an ca.', { timeout: 20_000 });
  const arrive = clockMin((await way.textContent())!.match(/an ca\. (\d\d:\d\d)/)![1]);
  const jan = page.getByTestId('pick').locator('.pick-athletes li').first();
  const pass = clockMin((await jan.textContent())!.match(/ca\. (\d\d:\d\d)/)![1]);
  expect(pass).toBeGreaterThan(arrive);
  await expect(jan).toContainText(`du bist ${dur(pass - arrive)} vorher da ✓`);
  await expect(jan.getByTestId('pick-ok')).toBeVisible();
  await expect(page.getByTestId('pick-late')).toHaveCount(0);
  await context.close();
});
