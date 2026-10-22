import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { legDistance } from '../src/course';
import { pointAtDistance } from '../src/geo';
import { correctionsFrom, liveFix, snapTrack, traccarLink, type LivePoint } from '../src/live';
import { qrSvg, speedText } from '../src/live-ui';
import type { Athlete, Leg, Point, RaceEvent } from '../src/model';
import { buildTimeline, setCorrections, timeAtAlong } from '../src/schedule';
import { normalizeLeg } from '../src/share';
import type { Sighting } from '../src/sightings';
import { expectOnScreen, fixture, mockBackend, newBackendStore, openApp, openSection, traccarSend, type BackendStore } from './helpers';

/* Stufe 6: Live-Standort per Traccar Client (in Tests: Attrappe + simulierte Meldungen). */

test.use({ serviceWorkers: 'block' });

const T = (hhmm: string) => Date.parse(`2026-08-23T${hhmm}:00+02:00`);
const TODAY = new Date(T('08:00'));
const STEP = 0.1 / 111.2; // 100 m in Breitengrad

const jan = (start = '10:00'): Athlete => ({ id: 'athlete-jan', name: 'Jan', color: '#d62839', start, pace: { schwimmen: 120, rad: 30, lauf: 330 }, transition: 0 });

/** Wendepunktstrecke: 10 km nach Norden und auf demselben Weg zurück. */
function outAndBack(): RaceEvent {
  const pts: Point[] = [];
  for (let i = 0; i <= 100; i++) pts.push({ lat: 53 + i * STEP, lng: 10 });
  for (let i = 99; i >= 0; i--) pts.push({ lat: 53 + i * STEP, lng: 10 });
  return { id: 'event-live-01', name: 'Wende', date: '2026-08-23', legs: [{ name: 'Rad', discipline: 'rad', points: pts, elevationGain: null }], athletes: [jan()] };
}

/** Position bei km x der Wendepunktstrecke (hin bzw. zurück) zur Uhrzeit. */
const at = (m: number, time: number): LivePoint => {
  const d = m <= 10_000 ? m : 20_000 - m;
  return { at: time, lat: 53 + (d / 100) * STEP, lng: 10.0004, acc: 4 }; // ~27 m neben der Strecke
};
/** Gleichmäßig mit v km/h ab `from` (m) zur Zeit t0, jede Minute ein Punkt. */
const ride = (kmh: number, t0: number, minutes: number, from = 0) =>
  Array.from({ length: minutes + 1 }, (_, i) => at(from + (kmh / 3.6) * 60 * i, t0 + i * 60_000));

test.describe('Logik', () => {
  test.afterEach(() => setCorrections(new Map()));

  test('Einrasten: auf dem Rückweg zählt die zweite Stelle, nicht die erste (gleicher Ort, Wendepunkt)', () => {
    const ev = outAndBack();
    // 30 km/h, 30 Minuten: Wende bei km 10 (10:20), dann zurück bis km 15
    const snapped = snapTrack(ev, ev.athletes[0], ride(30, T('10:00'), 30), TODAY);
    expect(snapped).toHaveLength(31);
    expect(Math.round(snapped[6].along / 100) / 10).toBe(3); // 10:06 km 3 (Hinweg)
    expect(Math.round(snapped[26].along / 100) / 10).toBe(13); // 10:26 km 13 = gleicher Ort wie km 7
    expect(Math.round(snapped[30].along / 100) / 10).toBe(15);
    // Abseits der Strecke (> 300 m): übergangen
    expect(snapTrack(ev, ev.athletes[0], [{ at: T('10:05'), lat: 53.02, lng: 10.01, acc: 5 }], TODAY)).toEqual([]);
  });

  test('Gesamt-Pace der laufenden Disziplin, nicht das Tempo der letzten Minute (Abfahrt verfälscht nicht)', () => {
    const ev = outAndBack();
    const a = ev.athletes[0];
    // Wartet am Start (09:55–10:00), fährt dann 13 min mit 36 km/h, die letzte Minute „Abfahrt“ mit 84 km/h
    const pts = [...ride(0, T('09:55'), 5), ...ride(36, T('10:00'), 13).slice(1)];
    pts.push(at(7800 + 1400, T('10:14')));
    const fix = liveFix(ev, a, snapTrack(ev, a, pts, TODAY))!;
    expect(fix.discipline).toBe('rad');
    expect(fix.along).toBeCloseTo(9200, -1);
    // Schnitt seit dem Losfahren um 10:00: 9,2 km in 14 min = 39,4 km/h (nicht 84, nicht 36)
    expect(speedText('rad', fix.measured!)).toBe('39,4 km/h');
    expect(fix.speeds.rad).toBeCloseTo(fix.measured!, 5); // > 2 km gemessen → nur noch gemessen
  });

  test('Am Start: kein Tempo-Anker, sondern „wartet“; kurz nach dem Start mit der Schätzung gemischt', () => {
    const ev = outAndBack();
    const a = ev.athletes[0];
    expect(liveFix(ev, a, snapTrack(ev, a, ride(0, T('09:50'), 10), TODAY))).toMatchObject({ waiting: true, measured: null, speeds: {} });
    expect(liveFix(ev, a, [])).toBeNull();
    // 1 km mit 40 km/h gemessen, Plan 30 km/h → halbe-halbe
    const fix = liveFix(ev, a, snapTrack(ev, a, [at(0, T('10:00')), at(1000, T('10:01') + 30_000)], TODAY))!;
    expect(fix.measured! * 3.6).toBeCloseTo(40, 0);
    expect(fix.speeds.rad! * 3.6).toBeCloseTo(35, 0);
  });

  test('Prognose: ab der letzten Live-Position mit gemessener Pace; eine neuere Sichtung wird Anker', () => {
    const ev = outAndBack();
    const a = ev.athletes[0];
    const fix = liveFix(ev, a, snapTrack(ev, a, ride(36, T('10:00'), 10), TODAY))!;
    expect(fix.along).toBeCloseTo(6000, -1);
    const fixes = new Map([[a.id!, fix]]);
    let c = correctionsFrom(ev, [], fixes, TODAY).get(a.id!)!;
    // km 6 um 10:10 (Plan: 10:12), danach 36 km/h → Wende (km 10) um 10:16:40 (auf 2 s genau)
    const tl = () => buildTimeline(ev, a, TODAY, c);
    const near = (t: number, expected: number) => expect(Math.abs(t - expected)).toBeLessThan(2000);
    near(timeAtAlong(tl(), 6000), T('10:10'));
    near(timeAtAlong(tl(), 10_000), T('10:16') + 40_000);
    // Ältere Sichtung ändert nichts
    const s = (along: number, hhmm: string): Sighting => ({ id: 's', athleteId: a.id!, along, seenAt: T(hhmm), mine: false });
    expect(correctionsFrom(ev, [s(3000, '10:05')], fixes, TODAY).get(a.id!)).toEqual(c);
    // Neuere Sichtung (Live still): km 9 um 10:16 → Anker, Pace bleibt gemessen
    c = correctionsFrom(ev, [s(9000, '10:16')], fixes, TODAY).get(a.id!)!;
    near(timeAtAlong(tl(), 9000), T('10:16'));
    expect(c.speeds?.rad).toBeCloseTo(10, 1);
  });

  test('Wartet am Start: nach der Startzeit beginnt der Plan erst, wenn er losfährt; vorher und ohne Meldung nicht', () => {
    const ev = outAndBack();
    const a = ev.athletes[0];
    const id = a.id!;
    const fixAt = (hhmm: string) => new Map([[id, liveFix(ev, a, snapTrack(ev, a, ride(0, T('09:50'), (T(hhmm) - T('09:50')) / 60_000), TODAY))!]]);
    // 09:58, Start 10:00: Plan gilt (keine Verschiebung)
    expect(correctionsFrom(ev, [], fixAt('09:58'), TODAY, T('09:58')).has(id)).toBe(false);
    // 10:07, steht noch am Start (letzte Meldung 10:07): Start = jetzt → 7 min später als geplant
    let c = correctionsFrom(ev, [], fixAt('10:07'), TODAY, T('10:07')).get(id)!;
    expect(c.offset).toBe(7 * 60_000);
    expect(timeAtAlong(buildTimeline(ev, a, TODAY, c), 3000)).toBe(T('10:13'));
    // Eine Minute später, Meldung noch frisch: Start wandert mit der Uhr
    c = correctionsFrom(ev, [], fixAt('10:07'), TODAY, T('10:08')).get(id)!;
    expect(c.offset).toBe(8 * 60_000);
    // Keine Meldung mehr seit 10:07 (still > 5 min): ab der letzten Meldung, nicht weiter verschoben
    c = correctionsFrom(ev, [], fixAt('10:07'), TODAY, T('10:30')).get(id)!;
    expect(c.offset).toBe(7 * 60_000);
  });

  test('Triathlon: gemessen wird nur die laufende Disziplin; kommende behalten die Schätzung', () => {
    const line = (from: number, to: number): Point[] => Array.from({ length: (to - from) / 100 + 1 }, (_, i) => ({ lat: 53 + ((from + i * 100) / 100) * STEP, lng: 10 }));
    const legs: Leg[] = [
      { name: 'Rad', discipline: 'rad', points: line(0, 10_000), elevationGain: null },
      { name: 'Lauf', discipline: 'lauf', points: line(10_000, 15_000), elevationGain: null },
    ];
    const ev: RaceEvent = { id: 'event-live-02', name: 'Duathlon', date: '2026-08-23', legs, athletes: [jan()] };
    const a = ev.athletes[0];
    // Rad 10 km in 15 min (40 km/h), Lauf ab 10:15: 2 km in 10 min (5:00 min/km)
    const onLine = (kmh: number, t0: number, minutes: number, from: number): LivePoint[] =>
      Array.from({ length: minutes + 1 }, (_, i) => ({ at: t0 + i * 60_000, lat: 53 + ((from + (kmh / 3.6) * 60 * i) / 100) * STEP, lng: 10.0004, acc: 4 }));
    const pts = [...onLine(40, T('10:00'), 15, 0), ...onLine(12, T('10:15'), 10, 10_000).slice(1)];
    const fix = liveFix(ev, a, snapTrack(ev, a, pts, TODAY))!;
    expect(fix.discipline).toBe('lauf');
    expect(speedText('lauf', fix.measured!)).toBe('5:00 min/km');
    expect(Object.keys(fix.speeds)).toEqual(['lauf']);
  });

  test('Einrichtungslink für Traccar Client und QR-Code', () => {
    const link = traccarLink('ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(link.startsWith('org.traccar.client://config?')).toBe(true);
    const q = new URL(link.replace('org.traccar.client://config', 'https://x/')).searchParams;
    expect(q.get('url')).toBe('https://uldwwhedugbygaukjkly.supabase.co/rest/v1/rpc/track?apikey=sb_publishable_k5lTVxYFROnQEBCDw0B4DQ_ZJNpmKcw');
    expect(Object.fromEntries(q)).toMatchObject({ id: 'ABCDEFGHIJKLMNOPQRSTUVWX', interval: '15', accuracy: 'highest', distance: '0', stop_detection: 'false', buffer: 'true' });
    const svg = qrSvg(link);
    expect(svg).toMatch(/^<svg class="qr"/);
    // ~280 Zeichen → Version 10–12 (57–65 Module) + Rand
    const size = Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);
    expect(size).toBeGreaterThanOrEqual(57 + 6);
    expect(size).toBeLessThanOrEqual(69 + 6);
  });
});

// ---------------------------------------------------------------- Oberfläche

const NORTH = { latitude: 53.3003, longitude: 10.4117 }; // an der Strecke, km 9,4

/** Strecke der Testdatei so, wie die App sie hat (vereinfacht wie im Link). */
function fixtureLeg(): Leg {
  const xml = readFileSync(fixture('radrennen-lueneburg.gpx'), 'utf8');
  const points = [...xml.matchAll(/<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g)].map((m) => ({ lat: Number(m[1]), lng: Number(m[2]) }));
  return normalizeLeg({ name: 'Rad', discipline: 'rad', points, elevationGain: null });
}

async function device(browser: Browser, info: TestInfo, store: BackendStore, hhmm: string, geo = NORTH): Promise<Page> {
  const ctx = await browser.newContext({ ...info.project.use, geolocation: geo, permissions: ['geolocation'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await mockBackend(page, store);
  await page.clock.setFixedTime(new Date(T(hhmm)));
  return page;
}

/** Neuer Abruf wie beim Zurückkehren in die App. */
async function wake(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test('Live-Tracking: einrichten per QR/Link, Position + Pace aus Traccar, Sichtung/Pace entfallen, still → geschätzt, beenden', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  const a = await device(browser, info, store, '10:10');
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await a.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = a.locator('#athlete-dialog');
  // Neuer Athlet: noch kein Live-Abschnitt
  await expect(d.getByTestId('live-setup')).toBeHidden();
  await d.getByLabel('Name des Athleten').fill('Jan');
  await d.getByLabel('Startzeit').fill('10:00');
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(a.locator('#toast')).toHaveText('Jan hinzugefügt.');
  const row = a.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(row.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 5,0');

  // Noch nicht geteilt → Hinweis statt Einrichtung
  await row.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await expect(d.getByTestId('live-setup')).toContainText('sobald das Event geteilt ist');
  await d.getByRole('button', { name: 'Abbrechen' }).click();

  // Teilen → Event liegt auf dem Server
  await openSection(a, 'Strecke');
  await a.getByRole('button', { name: 'Link teilen' }).click();
  await expect(a.getByTestId('share-link')).toHaveValue(/#e=[A-Za-z0-9_-]+$/);
  const link = await a.getByTestId('share-link').inputValue();
  await a.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect.poll(() => store.events.size).toBe(1);
  const eventId = [...store.events.keys()][0];

  // Standort an der Strecke: „Jan jetzt hier“ wird angeboten (Gegenprobe zu später)
  await openSection(a, 'Athleten');
  await a.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(a.getByRole('button', { name: 'Jan jetzt hier' })).toHaveCount(1);

  // Einrichten
  await row.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await d.getByRole('button', { name: 'Live-Tracking einrichten' }).click();
  await expect(d.getByTestId('live-qr')).toBeVisible();
  await expectOnScreen(d.getByTestId('live-qr'), 120);
  await expectOnScreen(d.getByTestId('live-open'));
  expect(store.trackers).toHaveLength(1);
  const token = store.trackers[0].token;
  const href = (await d.getByTestId('live-open').getAttribute('href'))!;
  expect(href.startsWith('org.traccar.client://config?')).toBe(true);
  expect(new URL(href.replace('org.traccar.client://config', 'https://x/')).searchParams.get('id')).toBe(token);
  // Tempo-Felder noch da (keine Live-Daten)
  await expect(d.getByLabel('Rad-Tempo in km/h')).toBeVisible();
  await d.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(row.getByTestId('athlete-live')).toHaveText('Live-Tracking eingerichtet – noch keine Position');

  // Traccar meldet: 10:00–10:10 mit 36 km/h → km 6,0 (Plan wäre km 5,0)
  const leg = fixtureLeg();
  expect(legDistance(leg)).toBeGreaterThan(10_000);
  for (let i = 0; i <= 10; i++) {
    const p = pointAtDistance(leg.points, i * 600);
    expect(traccarSend(store, token, p.lat, p.lng, T('10:00') + i * 60_000)).toBe(true);
  }
  expect(traccarSend(store, 'falsches-token-xxxxxxxxx', 53.3, 10.4, T('10:10'))).toBe(false);
  await wake(a);
  await expect(row.getByTestId('athlete-status')).toHaveText('Live bei km 6,0');
  await expect(row.getByTestId('athlete-live')).toHaveText('Live gerade eben · Ø 36,0 km/h');
  // Sichtung entfällt, obwohl der Standort an der Strecke liegt
  await expect(a.getByRole('button', { name: 'Jan jetzt hier' })).toHaveCount(0);
  // Karte: Marker als „live“ markiert
  await expect(a.getByTestId('athlete-pin').filter({ hasText: 'Jan' })).toHaveClass(/is-live/);
  // Dialog: Tempo kommt aus dem Tracking
  await row.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await expect(d.getByTestId('pace-live-note')).toBeVisible();
  await expect(d.getByLabel('Rad-Tempo in km/h')).toBeHidden();
  await d.getByRole('button', { name: 'Abbrechen' }).click();
  // Leiste unten
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await expect(a.getByTestId('statusbar')).toContainText('km 6,0');
  await expect(a.getByTestId('statusbar')).toContainText('live');

  // 90 s später, noch keine neue Meldung: echte Position bleibt stehen (kein Vorausschieben,
  // sonst überholt er sich selbst, wenn er langsamer wird) – „bei dir“ rechnet trotzdem weiter
  await a.clock.setFixedTime(new Date(T('10:11') + 30_000));
  await openSection(a, 'Athleten');
  await expect(row.getByTestId('athlete-status')).toHaveText('Live bei km 6,0');
  await expect(row.getByTestId('athlete-here')).toContainText('ca. 10:16');
  // Nach über 2 min ohne Meldung (Funkloch): geschätzt weiter mit Ø 36 km/h → 10:13 bei km 7,8
  await a.clock.setFixedTime(new Date(T('10:13')));
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await openSection(a, 'Athleten');
  await expect(row.getByTestId('athlete-status')).toHaveText('Geschätzt bei km 7,8');
  await expect(a.getByRole('button', { name: 'Jan jetzt hier' })).toHaveCount(0); // erst nach 5 min wieder
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await a.clock.setFixedTime(new Date(T('10:10')));

  // Zweites Gerät mit dem Link sieht dasselbe und bekommt den Einrichtungslink gleich angezeigt
  const b = await device(browser, info, store, '10:10', { latitude: 53.27, longitude: 10.45 });
  await openApp(b, new URL(link).hash);
  await openSection(b, 'Athleten');
  const rowB = b.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(rowB.getByTestId('athlete-status')).toHaveText('Live bei km 6,0');
  await rowB.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await expect(b.locator('#athlete-dialog').getByTestId('live-open')).toHaveAttribute('href', href);
  await b.context().close();

  // 7 Minuten nichts mehr (Funkloch): ab km 6,0 mit 36 km/h weiter → km 10,2; Sichtung wieder möglich
  await a.clock.setFixedTime(new Date(T('10:17')));
  await openSection(a, 'Athleten');
  await expect(row.getByTestId('athlete-status')).toHaveText('Geschätzt bei km 10,2');
  await expect(row.getByTestId('athlete-live')).toHaveText('Zuletzt live vor 7 min · Ø 36,0 km/h');
  await expect(a.getByRole('button', { name: 'Jan jetzt hier' })).toHaveCount(1);

  // Beenden: Token und Positionen weg, zurück auf den Plan
  await row.getByRole('button', { name: 'Jan bearbeiten' }).click();
  a.once('dialog', (dlg) => void dlg.accept());
  await d.getByRole('button', { name: 'Live-Tracking beenden' }).click();
  await expect(a.locator('#toast')).toHaveText('Live-Tracking für Jan beendet.');
  expect(store.trackers).toHaveLength(0);
  expect(store.positions).toHaveLength(0);
  await expect(d.getByRole('button', { name: 'Live-Tracking einrichten' })).toBeVisible();
  await d.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(row.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 8,5');
  await expect(row.getByTestId('athlete-live')).toHaveCount(0);
  expect(eventId).toMatch(/^[A-Za-z0-9_-]{8,40}$/);
  await a.context().close();
});

test('Wartet am Start: Startzeit vorbei, aber Live-Position noch am Start → Plan hält, bis er losfährt', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  const a = await device(browser, info, store, '10:07');
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await a.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = a.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill('Jan');
  await d.getByLabel('Startzeit').fill('10:00');
  await d.getByRole('button', { name: 'Speichern' }).click();
  await openSection(a, 'Strecke');
  await a.getByRole('button', { name: 'Link teilen' }).click();
  await expect(a.getByTestId('share-link')).toHaveValue(/#e=[A-Za-z0-9_-]+$/);
  await a.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect.poll(() => store.events.size).toBe(1);
  await openSection(a, 'Athleten');
  const row = a.getByTestId('athlete').filter({ hasText: 'Jan' });
  // Gegenprobe: ohne Live-Daten fährt er laut Plan seit 10:00
  await expect(row.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 3,5');
  await row.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await d.getByRole('button', { name: 'Live-Tracking einrichten' }).click();
  await expect(d.getByTestId('live-qr')).toBeVisible();
  await d.getByRole('button', { name: 'Abbrechen' }).click();
  const token = store.trackers[0].token;

  // Steht seit 09:55 am Start (Welle verschoben), letzte Meldung 10:05
  const leg = fixtureLeg();
  for (let m = 0; m <= 10; m++) {
    const p = pointAtDistance(leg.points, 20);
    traccarSend(store, token, p.lat + m * 1e-6, p.lng, T('09:55') + m * 60_000);
  }
  await wake(a);
  await expect(row.getByTestId('athlete-status')).toHaveText('Live: wartet am Start');
  await expect(row.getByTestId('athlete-live')).toHaveText('Live vor 2 min · am Start');
  // Plan beginnt erst jetzt (10:07, nicht bei der letzten Meldung 10:05): bei mir (km 9,4, 30 km/h) um 10:26
  await a.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(row.getByTestId('athlete-here')).toContainText('ca. 10:26');
  // Am Start noch geschätztes Tempo und Sichtung möglich (nichts gemessen)
  await row.getByRole('button', { name: 'Jan bearbeiten' }).click();
  await expect(d.getByLabel('Rad-Tempo in km/h')).toBeVisible();
  await d.getByRole('button', { name: 'Abbrechen' }).click();
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await expect(a.getByTestId('statusbar')).toContainText('wartet am Start · live');

  // Losgefahren um 10:07, um 10:10 bei km 1,8 (36 km/h)
  for (let i = 1; i <= 3; i++) {
    const p = pointAtDistance(leg.points, 20 + i * 600);
    traccarSend(store, token, p.lat, p.lng, T('10:07') + i * 60_000);
  }
  await a.clock.setFixedTime(new Date(T('10:10')));
  await openSection(a, 'Athleten');
  await expect(row.getByTestId('athlete-status')).toHaveText('Live bei km 1,8');
  await a.context().close();
});
