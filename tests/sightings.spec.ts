import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { adoptIds, hashId, ID_RE, randomId, withIds } from '../src/ids';
import type { Athlete, Point, RaceEvent } from '../src/model';
import { decodeEvent, encodeEvent, eventFromWire, eventToWire } from '../src/share';
import { setSightingOffsets, timeAtAlong, timeline } from '../src/schedule';
import { alongsNear, latestByAthlete, offsetsFrom, sightingAlong, type Sighting } from '../src/sightings';
import { fixture, mockBackend, newBackendStore, openApp, openSection, type BackendStore } from './helpers';

/* Stufe 5: Sichtungen („Jan jetzt hier“), geteilt über Supabase (in Tests eine Attrappe). */

test.use({ serviceWorkers: 'block' });

// ---------------------------------------------------------------- Logik

const T = (hhmm: string) => Date.parse(`2026-08-23T${hhmm}:00+02:00`);
const TODAY = new Date(T('08:00'));

/** Wendepunktstrecke: 10 km nach Norden und auf demselben Weg zurück. */
function outAndBack(): RaceEvent {
  const pts: Point[] = [];
  const step = 0.1 / 111.2; // 100 m in Breitengrad
  for (let i = 0; i <= 100; i++) pts.push({ lat: 53 + i * step, lng: 10 });
  for (let i = 99; i >= 0; i--) pts.push({ lat: 53 + i * step, lng: 10 });
  const athlete: Athlete = { id: 'athlete-jan', name: 'Jan', color: '#d62839', start: '10:00', pace: { schwimmen: 120, rad: 30, lauf: 330 }, transition: 0 };
  return { id: 'event-test-1', name: 'Wende', date: '2026-08-23', legs: [{ name: 'Rad', discipline: 'rad', points: pts, elevationGain: null }], athletes: [athlete] };
}

test.describe('Logik', () => {
  test.afterEach(() => setSightingOffsets(new Map()));

  test('Wendepunkt: dieselbe Stelle liegt zweimal auf der Strecke, gewählt wird der zeitlich passende Durchgang', () => {
    const ev = outAndBack();
    const at3km = { lat: 53 + 30 * (0.1 / 111.2), lng: 10.0005 }; // ~35 m neben km 3 bzw. km 17
    const near = alongsNear(ev, at3km);
    expect(near.map((n) => Math.round(n.along / 100) / 10)).toEqual([3, 17]);
    // 30 km/h: km 3 um 10:06, km 17 um 10:34
    expect(Math.round(sightingAlong(ev, ev.athletes[0], at3km, T('10:07'))! / 1000)).toBe(3);
    expect(Math.round(sightingAlong(ev, ev.athletes[0], at3km, T('10:33'))! / 1000)).toBe(17);
    // Weit weg von der Strecke: keine Stelle
    expect(sightingAlong(ev, ev.athletes[0], { lat: 53.05, lng: 10.01 }, T('10:07'))).toBeNull();
  });

  test('Sichtung verschiebt den Zeitplan um die Abweichung; die jüngste zählt', () => {
    const ev = outAndBack();
    const jan = ev.athletes[0];
    const s = (along: number, hhmm: string, id: string): Sighting => ({ id, athleteId: jan.id!, along, seenAt: T(hhmm), mine: false });
    // km 3 laut Plan um 10:06 – gesichtet um 10:08 → 2 min später
    const list = [s(3000, '10:08', 'a'), s(1000, '10:01', 'alt')];
    expect(latestByAthlete(list).get(jan.id!)!.id).toBe('a');
    const offsets = offsetsFrom(ev, list, TODAY);
    expect(Math.round(offsets.get(jan.id!)! / 1000)).toBe(120);
    setSightingOffsets(offsets);
    // Danach liegt km 10 (Wende) bei 10:20 + 2 min
    expect(new Date(timeAtAlong(timeline(ev, jan, TODAY), 10_000)).toISOString()).toBe(new Date(T('10:22')).toISOString());
    // Rohzeitplan bleibt unverändert
    expect(new Date(timeAtAlong(timeline(ev, jan, TODAY, true), 10_000)).toISOString()).toBe(new Date(T('10:20')).toISOString());
  });

  test('Kennungen: zufällig für Neues, berechnet (und auf allen Geräten gleich) für alte Links, im Link enthalten', () => {
    expect(randomId()).toMatch(ID_RE);
    expect(randomId()).not.toBe(randomId());
    expect(hashId('abc', 'h')).toBe(hashId('abc', 'h'));
    const ev = outAndBack();
    const old: RaceEvent = { ...ev, id: undefined, athletes: ev.athletes.map((a) => ({ ...a, id: undefined })) };
    const a = withIds(old);
    const b = withIds(structuredClone(old));
    expect(a.id).toMatch(ID_RE);
    expect(a.id).toBe(b.id);
    expect(a.athletes[0].id).toBe(b.athletes[0].id);
    // Vorhandene Kennungen bleiben
    expect(withIds(ev)).toBe(ev);
    // Teilen-Link transportiert sie
    const back = eventFromWire(JSON.parse(JSON.stringify(eventToWire(ev))));
    expect(back.id).toBe('event-test-1');
    expect(back.athletes[0].id).toBe('athlete-jan');
    // Ungültige Kennung im Link wird ignoriert
    const wire = eventToWire(ev) as unknown as { i: string };
    wire.i = '<script>';
    expect(eventFromWire(wire).id).toBeUndefined();
  });
});

test('Kennungen aus dem letzten Link übernehmen: nur bei gleicher Strecke, Athleten über Name + Startzeit', () => {
  const linked = outAndBack();
  const saved: RaceEvent = { ...linked, id: 'h00000000001', athletes: [{ ...linked.athletes[0], id: undefined }, { ...linked.athletes[0], name: 'Max', id: 'a00000000002' }] };
  const r = adoptIds(saved, linked);
  expect(r.id).toBe('event-test-1');
  expect(r.athletes[0].id).toBe('athlete-jan');
  expect(r.athletes[1].id).toBe('a00000000002'); // Max steht nicht im Link → bleibt
  // Andere Strecke → nichts übernehmen
  const other = { ...linked, legs: [{ ...linked.legs[0], points: linked.legs[0].points.slice(0, 50) }] };
  expect(adoptIds(saved, other)).toBe(saved);
  // Andere Startzeit → kein Treffer
  expect(adoptIds({ ...saved, athletes: [{ ...saved.athletes[0], start: '11:00' }] }, linked).athletes[0].id).toBeUndefined();
});

// ---------------------------------------------------------------- Oberfläche (zwei Geräte)

const NORTH = { latitude: 53.3003, longitude: 10.4117 }; // an der Strecke, km 9,4

async function device(browser: Browser, info: TestInfo, store: BackendStore, hhmm: string, geo = NORTH): Promise<Page> {
  const ctx = await browser.newContext({ ...info.project.use, geolocation: geo, permissions: ['geolocation'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await mockBackend(page, store);
  await page.clock.setFixedTime(new Date(T(hhmm)));
  return page;
}

async function addJan(page: Page) {
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = page.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill('Jan');
  await d.getByLabel('Startzeit').fill('10:00');
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#toast')).toHaveText('Jan hinzugefügt.');
}

async function reopenAthletes(page: Page) {
  await page.locator('.ctrl-section-btn[aria-label="Strecke"]').click();
  await openSection(page, 'Athleten');
}

test('„Jan jetzt hier“: Zeitplan springt auf die echte Zeit, andere Geräte mit dem Link sehen es, Zurücknehmen wirkt überall', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  const a = await device(browser, info, store, '10:10');
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addJan(a);
  const row = a.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(row.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 5,0');

  // Ohne Standort kein „jetzt hier“
  await expect(a.getByRole('button', { name: 'Jan jetzt hier' })).toHaveCount(0);
  await a.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(a.getByTestId('user-dot')).toHaveCount(1);
  await a.getByRole('button', { name: 'Jan jetzt hier' }).click();
  await expect(a.locator('#toast')).toHaveText('Jan bei km 9,4 gesichtet – Zeitplan angepasst.');

  // Zeitplan: Jan ist jetzt bei mir (km 9,4), nicht mehr bei km 5,0
  await expect(row.getByTestId('athlete-status')).toHaveText('Nach Sichtung bei km 9,4');
  await expect(row.getByTestId('athlete-sighting')).toHaveText(/^Gesichtet um 10:10 bei km 9,4 · von dir zurücknehmen$/);
  await expect.poll(() => store.rows.length).toBe(1);
  expect(store.rows[0].along_m).toBeGreaterThan(9300);
  expect(store.rows[0].along_m).toBeLessThan(9500);
  expect(store.rows[0].event_id).toMatch(/^[A-Za-z0-9_-]{8,40}$/);
  // Leiste unten zeigt die korrigierte Position
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await expect(a.getByTestId('statusbar')).toContainText('km 9,4');
  // … und dass die Zeit auf einer Sichtung beruht
  await expect(a.getByTestId('statusbar')).toContainText('gesichtet 10:10');

  // Link teilen → zweites Gerät, zwei Minuten später
  await openSection(a, 'Strecke');
  await a.getByRole('button', { name: 'Link teilen' }).click();
  await expect(a.getByTestId('share-link')).toHaveValue(/#e=[A-Za-z0-9_-]+$/);
  const link = await a.getByTestId('share-link').inputValue();
  await a.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();

  const b = await device(browser, info, store, '10:12', { latitude: 53.27, longitude: 10.45 });
  await openApp(b, new URL(link).hash);
  await openSection(b, 'Athleten');
  const rowB = b.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(rowB.getByTestId('athlete-sighting')).toHaveText('Gesichtet um 10:10 bei km 9,4');
  // 2 min bei 30 km/h nach der Sichtung → km 10,4 (ohne Sichtung wäre es km 6,0)
  await expect(rowB.getByTestId('athlete-status')).toHaveText('Nach Sichtung bei km 10,4');
  await expect(rowB.getByRole('button', { name: 'zurücknehmen' })).toHaveCount(0);

  // A nimmt zurück → bei B nach dem Abgleich wieder der Plan
  await openSection(a, 'Athleten');
  await row.getByRole('button', { name: 'zurücknehmen' }).click();
  await expect(a.locator('#toast')).toHaveText('Sichtung zurückgenommen.');
  await expect(row.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 5,0');
  await expect.poll(() => store.rows.length).toBe(0);
  await reopenAthletes(b);
  await expect(rowB.getByTestId('athlete-sighting')).toHaveCount(0);
  await expect(rowB.getByTestId('athlete-status')).toHaveText('Laut Plan bei km 6,0');

  // Gespeichert wird nichts Persönliches: nur Kennungen, Stelle und Zeit
  expect(Object.keys((await (async () => store.rows[0] ?? { id: '', event_id: '', athlete_id: '', along_m: 0, seen_at: '', created_by: '' })()))).toEqual([
    'id',
    'event_id',
    'athlete_id',
    'along_m',
    'seen_at',
    'created_by',
  ]);
  await a.context().close();
  await b.context().close();
});

test('Offline: Sichtung wirkt sofort auf dem Gerät und wird nachgereicht', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  const a = await device(browser, info, store, '10:10');
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addJan(a);
  await a.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(a.getByTestId('user-dot')).toHaveCount(1);

  store.status = 503;
  await a.getByRole('button', { name: 'Jan jetzt hier' }).click();
  const row = a.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(row.getByTestId('athlete-status')).toHaveText('Nach Sichtung bei km 9,4');
  await expect(row.getByTestId('athlete-sighting')).toContainText('wird übertragen');
  await expect(a.getByTestId('sight-hint')).toContainText('Gerade offline');
  expect(store.rows).toHaveLength(0);

  // Wieder online → beim nächsten Abgleich hochgeladen
  store.status = 200;
  await reopenAthletes(a);
  await expect(row.getByTestId('athlete-sighting')).toHaveText(/^Gesichtet um 10:10 bei km 9,4 · von dir zurücknehmen$/);
  await expect.poll(() => store.rows.length).toBe(1);
  await expect(a.getByTestId('sight-hint')).not.toContainText('offline');
  // Nach dem Neuladen noch da (lokal gespeichert und vom Server)
  await a.reload();
  await a.locator('body[data-ready="true"]').waitFor();
  await openSection(a, 'Athleten');
  await expect(row.getByTestId('athlete-status')).toHaveText('Nach Sichtung bei km 9,4');
  await a.context().close();
});

test('Anonyme Anmeldung im Projekt aus: Sichtung geht nicht verloren, sondern wird nachgereicht', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  store.signupDisabled = true;
  const a = await device(browser, info, store, '10:10');
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addJan(a);
  await a.getByRole('button', { name: 'Standort anzeigen' }).click();
  await expect(a.getByTestId('user-dot')).toHaveCount(1);
  await a.getByRole('button', { name: 'Jan jetzt hier' }).click();
  const row = a.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(a.getByTestId('sight-hint')).toContainText('Gerade offline');
  await reopenAthletes(a);
  await expect(row.getByTestId('athlete-sighting')).toContainText('wird übertragen');
  expect(store.rows).toHaveLength(0);
  store.signupDisabled = false;
  await reopenAthletes(a);
  await expect.poll(() => store.rows.length).toBe(1);
  await expect(row.getByTestId('athlete-sighting')).not.toContainText('wird übertragen');
  await a.context().close();
});

test('Ohne Athleten wird der Dienst gar nicht angesprochen', async ({ page }) => {
  const store = await mockBackend(page);
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await expect(page.getByTestId('section-title')).toHaveText('Athleten');
  await page.waitForTimeout(500);
  expect(store.calls).toEqual([]);
});

test('Neue App-Version liest den letzten Link noch einmal: Sichtung passt wieder, auch wenn eine alte Version die Kennungen verloren hat', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  // Event wie im Link (mit Kennungen) und wie es eine alte App-Version gespeichert hätte (ohne)
  const ev = withIds({ ...outAndBack(), id: 'shared-event-0001' });
  const linkToken = await encodeEvent(ev);
  const stripped = await encodeEvent({ ...ev, id: undefined, athletes: ev.athletes.map((a) => ({ ...a, id: undefined })) });
  // Gegenprobe der Vorbereitung: der gespeicherte Stand hat wirklich keine Kennungen
  expect((await decodeEvent(stripped)).athletes[0].id).toBeUndefined();
  store.rows.push({ id: 's-1', event_id: 'shared-event-0001', athlete_id: 'athlete-jan', along_m: 3000, seen_at: new Date(T('10:08')).toISOString(), created_by: 'user-x' });

  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await mockBackend(page, store);
  await page.clock.setFixedTime(new Date(T('10:10')));
  // Stand nach dem Update: gespeichertes Event ohne Kennungen, Link zuletzt mit einer alten Version gelesen
  await page.addInitScript(
    ([saved, last]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('supbuddy:event', saved);
      localStorage.setItem('supbuddy:last-link', last);
    },
    [stripped, JSON.stringify({ token: linkToken, build: 'alte Version' })] as const,
  );
  await openApp(page);
  await openSection(page, 'Athleten');
  const row = page.getByTestId('athlete').filter({ hasText: 'Jan' });
  await expect(row.getByTestId('athlete-sighting')).toHaveText('Gesichtet um 10:08 bei km 3,0');
  await expect(row.getByTestId('athlete-status')).toHaveText(/^Nach Sichtung bei km /);
  await ctx.close();
});

test('Gleiche App-Version: der letzte Link wird nicht erneut gelesen (lokale Änderungen bleiben)', async ({ browser }, info) => {
  const store = newBackendStore();
  const ev = withIds({ ...outAndBack(), id: 'shared-event-0002' });
  const stripped = await encodeEvent({ ...ev, id: undefined, athletes: ev.athletes.map((a) => ({ ...a, id: undefined })) });
  store.rows.push({ id: 's-2', event_id: 'shared-event-0002', athlete_id: 'athlete-jan', along_m: 3000, seen_at: new Date(T('10:08')).toISOString(), created_by: 'user-x' });
  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await mockBackend(page, store);
  await page.clock.setFixedTime(new Date(T('10:10')));
  // Build-Kennung der laufenden App auslesen und als „schon gelesen mit dieser Version“ hinterlegen
  await openApp(page);
  const build = (await page.getByTestId('version').textContent())!;
  await page.evaluate(
    ([saved, last]) => {
      localStorage.setItem('supbuddy:event', saved);
      localStorage.setItem('supbuddy:last-link', last);
    },
    [stripped, JSON.stringify({ token: await encodeEvent(ev), build })] as const,
  );
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await openSection(page, 'Athleten');
  await expect(page.getByTestId('athlete').filter({ hasText: 'Jan' }).getByTestId('athlete-sighting')).toHaveCount(0);
  await ctx.close();
});
