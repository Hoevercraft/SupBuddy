import { test, expect, type Page } from '@playwright/test';
import { suggestTicket, groupPrice, LAND_TICKETS } from '../src/tickets';
import { readFileSync } from 'node:fs';
import { chooseJourney, decodePolyline, delfiId, legLabel, parseJourneys, rideLegs, type Journey, type TransitLeg } from '../src/transit';
import { encodePolyline, fixture, mockRouting, mockTransit, openApp, openSection } from './helpers';

/* Stufe 4: Bus & Bahn im Anfeuer-Plan, Anzahl Supporter, Ticket-Tipp. */

test.use({ serviceWorkers: 'block' });

// ---------------------------------------------------------------- Logik

const T = (hhmm: string, day = '2026-08-23') => Date.parse(`${day}T${hhmm}:00+02:00`);
function journey(start: string, end: string, kreise: string[], opts: { transfers?: number; day?: string; walkOnly?: boolean } = {}): Journey {
  const day = opts.day;
  const legs: TransitLeg[] = opts.walkOnly
    ? [{ mode: 'WALK', from: { name: 'START', time: T(start, day) }, to: { name: 'END', time: T(end, day) }, points: [] }]
    : kreise.map((k) => ({
        mode: 'BUS',
        line: '5009',
        from: { name: 'A', time: T(start, day), stopId: `de:${k}:1` },
        to: { name: 'B', time: T(end, day), stopId: `de:${k}:2` },
        points: [],
      }));
  return { start: T(start, day), end: T(end, day), transfers: opts.transfers ?? 0, legs };
}

test.describe('Logik', () => {
  test('Polyline: Google-Beispiel und Hin-und-zurück mit 7 Stellen', () => {
    const g = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(g.map((p) => [p.lat, p.lng])).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
    const pts = [
      { lat: 53.2464123, lng: 10.4115456 },
      { lat: 53.22, lng: 10.39 },
      { lat: 53.2199999, lng: 10.3900001 },
    ];
    const back = decodePolyline(encodePolyline(pts), 7);
    back.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(pts[i].lat, 7);
      expect(p.lng).toBeCloseTo(pts[i].lng, 7);
    });
  });

  test('Echte Transitous-Antwort (Lüneburg, Bus) wird richtig gelesen', () => {
    const data = JSON.parse(readFileSync(fixture('transitous-lueneburg.json'), 'utf8'));
    const js = parseJourneys(data)!;
    expect(js.length).toBe(3);
    const j = js[0];
    expect(new Date(j.start).toISOString()).toBe('2026-10-17T07:07:00.000Z');
    expect(new Date(j.end).toISOString()).toBe('2026-10-17T07:42:00.000Z');
    const rides = rideLegs(j);
    expect(rides).toHaveLength(1);
    expect(legLabel(rides[0])).toBe('Bus 5001');
    expect(rides[0].from.stopId).toMatch(/^de:03355:/);
    // Geometrie liegt in Lüneburg
    for (const l of j.legs) for (const p of l.points) {
      expect(p.lat).toBeGreaterThan(53.1);
      expect(p.lat).toBeLessThan(53.4);
      expect(p.lng).toBeGreaterThan(10.2);
      expect(p.lng).toBeLessThan(10.6);
    }
    expect(j.legs.every((l) => l.points.length >= 2)).toBe(true);
  });

  test('DELFI-Kennung und Linien-Texte', () => {
    expect(delfiId('de-DELFI_de:03355:15072::15007201')).toBe('de:03355:15072');
    expect(delfiId('irgendwas')).toBeUndefined();
    const leg = (mode: string, line?: string) => ({ mode, line, from: { name: '', time: 0 }, to: { name: '', time: 0 }, points: [] });
    expect(legLabel(leg('BUS', '5009'))).toBe('Bus 5009');
    expect(legLabel(leg('SUBURBAN', 'S3'))).toBe('S3');
    expect(legLabel(leg('REGIONAL_RAIL', 'RE3'))).toBe('RE3');
    expect(legLabel(leg('TRAM', '4'))).toBe('Tram 4');
    expect(legLabel(leg('BUS'))).toBe('Bus');
  });

  test('Verbindung wählen: rechtzeitig und kürzeste Reisezeit, sonst früheste Ankunft', () => {
    const a = journey('09:00', '09:40', ['03355']); // 40 min
    const b = journey('09:15', '09:40', ['03355'], { transfers: 1 }); // 25 min
    const c = journey('08:30', '09:00', ['03355']); // vor dem frühesten Aufbruch
    expect(chooseJourney([a, b, c], T('08:55'), T('09:45'))).toEqual({ journey: b, inTime: true });
    // Nichts rechtzeitig → früheste Ankunft, als „knapp“
    expect(chooseJourney([a, b], T('08:55'), T('09:30'))).toEqual({ journey: a, inTime: false });
    expect(chooseJourney([c], T('08:55'), T('09:30'))).toBeNull();
  });

  test('Ticket-Tipp: Niedersachsen für 4, ab 6 Personen zwei Tickets, hvv-Hinweis im hvv-Gebiet', () => {
    const sat = new Date(T('10:00'));
    const tip = suggestTicket([journey('10:00', '10:20', ['03355'])], 4, sat);
    expect(tip.land).toMatchObject({ name: 'Niedersachsen-Ticket', tickets: 1, price: 53 });
    expect(tip.verbund?.name).toBe('hvv');
    // 7 Personen: 5er (61 €) + 2er (37 €)
    expect(suggestTicket([journey('10:00', '10:20', ['03355'])], 7, sat).land).toMatchObject({ tickets: 2, price: 98 });
    // Hamburg + Niedersachsen: Niedersachsen-Ticket gilt in beiden
    expect(suggestTicket([journey('10:00', '10:20', ['02000', '03355'])], 2, sat).land?.name).toBe('Niedersachsen-Ticket');
    // Nur zu Fuß → kein Ticket
    expect(suggestTicket([journey('10:00', '10:20', [], { walkOnly: true })], 3, sat).none).toBe(true);
    expect(suggestTicket([], 3, sat).none).toBe(true);
  });

  test('Ticket-Tipp: Mo–Fr vor 9 Uhr Hinweis, NRW-Gruppe, Länder ohne gemeinsames Ticket', () => {
    const mon = '2026-08-24';
    const early = suggestTicket([journey('08:10', '08:40', ['09162'], { day: mon })], 3, new Date(T('08:00', mon)));
    expect(early.land?.name).toBe('Bayern-Ticket');
    expect(early.land?.note).toContain('erst ab 9 Uhr');
    expect(early.verbund?.name).toBe('MVV');
    // Samstag früh: kein Hinweis
    expect(suggestTicket([journey('08:10', '08:40', ['09162'])], 3, new Date(T('08:00'))).land?.note).toBeUndefined();
    expect(suggestTicket([journey('10:00', '10:20', ['05315'])], 1, new Date(T('10:00'))).land).toMatchObject({ price: 39.8 });
    expect(suggestTicket([journey('10:00', '10:20', ['05315'])], 3, new Date(T('10:00'))).land).toMatchObject({ price: 59.8 });
    const mixed = suggestTicket([journey('10:00', '10:20', ['05315', '03355'])], 2, new Date(T('10:00')));
    expect(mixed.land).toBeUndefined();
    expect(mixed.uncovered).toEqual(['Nordrhein-Westfalen', 'Niedersachsen']);
  });

  test('Gruppenpreise je Ticketart', () => {
    const by = (n: string) => LAND_TICKETS.find((t) => t.name === n)!;
    const sat = new Date(T('10:00'));
    expect(groupPrice(by('Brandenburg-Berlin-Ticket'), 5, sat).price).toBe(36.5);
    expect(groupPrice(by('Bayern-Ticket'), 5, sat).price).toBe(74);
    expect(groupPrice(by('Mecklenburg-Vorpommern-Ticket'), 2, sat).price).toBe(33); // Samstag: Fr–So-Preis
    expect(groupPrice(by('Mecklenburg-Vorpommern-Ticket'), 2, new Date(T('10:00', '2026-08-25'))).price).toBe(30); // Dienstag
  });
});

// ---------------------------------------------------------------- Oberfläche

const INSIDE_EAST = { latitude: 53.27, longitude: 10.45 }; // innerhalb der Runde, ~3 km von der Strecke

async function addAthlete(page: Page, name: string, start: string, kmh: string) {
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = page.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill(name);
  await d.getByLabel('Startzeit').fill(start);
  await d.getByLabel('Rad-Tempo in km/h').fill(kmh);
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#toast')).toHaveText(`${name} hinzugefügt.`);
}

async function setup(page: Page) {
  await page.clock.setFixedTime(new Date('2026-08-23T09:00:00+02:00'));
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(page, 'Jan', '10:00', '25');
  await page.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(page.getByTestId('user-dot')).toHaveCount(1);
  await openSection(page, 'Anfeuer-Plan');
  await page.getByRole('button', { name: 'Bus & Bahn', exact: true }).click();
}

async function makePlan(page: Page) {
  const before = await page.evaluate(() => document.body.dataset.planned ?? '');
  await page.getByRole('button', { name: 'Plan erstellen' }).click();
  await page.waitForFunction((b) => (document.body.dataset.planned ?? '') !== b, before, { timeout: 45_000 });
}

async function context(browser: import('@playwright/test').Browser, info: import('@playwright/test').TestInfo) {
  const ctx = await browser.newContext({ ...info.project.use, geolocation: INSIDE_EAST, permissions: ['geolocation'], serviceWorkers: 'block' });
  return { ctx, page: await ctx.newPage() };
}

test('Bus & Bahn: Stopps mit Verbindungen, Ticket-Tipp für die Gruppe, Navi im ÖPNV-Modus', async ({ browser }, info) => {
  test.slow();
  const { ctx, page } = await context(browser, info);
  await mockRouting(page, 3); // Fußwege lang → Bus lohnt sich
  const urls = await mockTransit(page, { kmh: 45 });
  await setup(page);

  // Statt Tempo: Anzahl Supporter
  await expect(page.getByLabel('Dein Tempo in km/h')).toHaveCount(0);
  const people = page.getByLabel('Anzahl Supporter');
  await people.fill('4');
  await people.blur();
  await makePlan(page);

  const stops = page.getByTestId('stop');
  expect(await stops.count()).toBeGreaterThanOrEqual(1);
  const first = stops.first();
  await expect(first.locator('.stop-way')).toHaveText(/^Bus & Bahn · ca\. \d+ min$/);
  await expect(first.getByTestId('stop-legs')).toContainText(/Bus 5009 \d\d:\d\d Haltestelle Start → \d\d:\d\d Haltestelle Ziel/);
  // „Los“ = Abfahrt der Verbindung inkl. Fußweg, Ankunft = Ende der Verbindung, vor Jan
  const arriveText = (await first.getByTestId('stop-arrive').textContent())!;
  const [leave, arrive] = [...arriveText.matchAll(/(\d\d):(\d\d)/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  expect(arrive).toBeGreaterThan(leave);
  const jan = (await first.locator('.stop-athletes li.main').textContent())!.match(/(\d\d):(\d\d)/)!;
  expect(Number(jan[1]) * 60 + Number(jan[2]) - arrive).toBeGreaterThanOrEqual(3);

  // Fahrplan wurde mit „Ankunft bis“ abgefragt
  expect(urls.some((u) => u.includes('arriveBy=true'))).toBe(true);

  // Navi: Google im ÖPNV-Modus, ohne Zwischenziele
  const href = (await first.getByTestId('stop-nav').getAttribute('href'))!;
  expect(href).toMatch(/travelmode=transit|mode=transit/);
  expect(href).not.toMatch(/waypoint/);
  await expect(first.locator('.stop-via')).toHaveCount(0);

  // Ticket-Tipp für 4 Personen im Landkreis Lüneburg
  const tip = page.getByTestId('ticket-tip');
  await expect(tip).toContainText('Für 4 Personen: Niedersachsen-Ticket für zusammen ca. 53,00 €');
  await expect(tip).toContainText('hvv-Gruppenkarte');
  await expect(page.getByText('Fahrplandaten:')).toBeVisible();

  // Personenzahl ändern: Plan bleibt, Preis passt sich an
  const stopCount = await stops.count();
  await people.fill('7');
  await people.blur();
  await expect(tip).toContainText('Für 7 Personen: 2× Niedersachsen-Ticket für zusammen ca. 98,00 €');
  await expect(stops).toHaveCount(stopCount);

  // Weg auf der Karte
  await expect
    .poll(async () => ((await page.evaluate(() => (window as unknown as { __supbuddyMap: () => { planRoutes: number } }).__supbuddyMap())).planRoutes))
    .toBe(stopCount);
  await ctx.close();
});

test('Fahrplan nicht erreichbar: Plan mit Schätzung und klarem Hinweis, kein falscher Ticket-Tipp', async ({ browser }, info) => {
  test.slow();
  const { ctx, page } = await context(browser, info);
  await mockRouting(page, 3);
  const urls = await mockTransit(page, { status: 503 });
  await setup(page);
  await makePlan(page);
  await expect(page.getByTestId('plan-estimated')).toHaveText(/Fahrplan gerade nicht erreichbar: Zeiten nur geschätzt/);
  expect(await page.getByTestId('stop').count()).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('ticket-tip')).toHaveCount(0);
  // Bei Überlast wird einmal nachgefragt
  const first = urls[0];
  expect(urls.filter((u) => u === first).length).toBe(2);
  await ctx.close();
});

test('Punkt antippen mit Bus & Bahn zeigt die Verbindung', async ({ browser }, info) => {
  test.slow();
  const { ctx, page } = await context(browser, info);
  await mockRouting(page, 3);
  await mockTransit(page, { kmh: 45 });
  await setup(page);
  // Einen Streckenpunkt antippen, der frei auf der Karte liegt
  await page.waitForTimeout(1200);
  const p = await page.evaluate(() => {
    const st = (window as unknown as { __supbuddyMap: () => { courseScreen: number[][] } }).__supbuddyMap();
    const ok = st.courseScreen.filter(([x, y]) => {
      if (x < 40 || x > window.innerWidth - 70 || y < 40) return false;
      const el = document.elementFromPoint(x, y);
      return !!el && el.classList.contains('maplibregl-canvas');
    });
    return ok[Math.floor(ok.length / 2)] ?? null;
  });
  expect(p).not.toBeNull();
  if (info.project.use.hasTouch) await page.touchscreen.tap(p![0], p![1]);
  else await page.mouse.click(p![0], p![1]);
  await expect(page.getByTestId('pick')).toBeVisible();
  await expect(page.getByTestId('pick').getByRole('button', { name: 'Bus & Bahn' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('pick-go').click();
  await expect(page.getByTestId('pick-way')).toHaveText(/^Bus & Bahn · ca\. \d+ min · an ca\. \d\d:\d\d$/, { timeout: 20_000 });
  await expect(page.getByTestId('pick-legs')).toContainText('Bus 5009');
  await ctx.close();
});
