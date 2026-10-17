import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { canonical, keepLocalOnly, merge3 } from '../src/eventsync';
import type { Athlete, Point, RaceEvent } from '../src/model';
import { decodeEvent, encodeEvent, normalizeLeg } from '../src/share';
import { fixture, mockBackend, newBackendStore, openApp, openSection, type BackendStore } from './helpers';

/* Stufe 5b: Das ganze Event läuft live für alle mit dem Link. */

test.use({ serviceWorkers: 'block' });

// ---------------------------------------------------------------- Logik

const ath = (id: string, name: string, start = '10:00'): Athlete => ({ id, name, color: '#d62839', start, pace: { schwimmen: 120, rad: 30, lauf: 330 }, transition: 180 });

function baseEvent(): RaceEvent {
  const pts: Point[] = [];
  for (let i = 0; i <= 50; i++) pts.push({ lat: 53 + i * 0.001, lng: 10 + (i % 7) * 0.0003 });
  return {
    id: 'event-merge-01',
    name: 'Rennen',
    date: '2026-08-23',
    legs: [normalizeLeg({ name: 'Rad', discipline: 'rad', points: pts, elevationGain: null })],
    athletes: [ath('athlete-jan-1', 'Jan'), ath('athlete-max-1', 'Max')],
  };
}

test.describe('Zusammenführen', () => {
  test('Beide fügen einen Athleten hinzu → beide sind da', () => {
    const base = baseEvent();
    const local = { ...base, athletes: [...base.athletes, ath('athlete-lisa-1', 'Lisa')] };
    const remote = { ...base, athletes: [...base.athletes, ath('athlete-tom-01', 'Tom')] };
    expect(merge3(base, local, remote).athletes.map((a) => a.name)).toEqual(['Jan', 'Max', 'Tom', 'Lisa']);
  });

  test('Verschiedene Felder geändert → beide Änderungen bleiben', () => {
    const base = baseEvent();
    const local = { ...base, athletes: [ath('athlete-jan-1', 'Jan', '10:30'), base.athletes[1]] };
    const remote = { ...base, date: '2026-08-24', name: 'Neuer Name' };
    const m = merge3(base, local, remote);
    expect(m.athletes[0].start).toBe('10:30');
    expect(m.date).toBe('2026-08-24');
    expect(m.name).toBe('Neuer Name');
  });

  test('Löschen: lokal gelöscht und remote unverändert → weg; remote inzwischen bearbeitet → bleibt', () => {
    const base = baseEvent();
    const local = { ...base, athletes: [base.athletes[0]] };
    expect(merge3(base, local, base).athletes.map((a) => a.name)).toEqual(['Jan']);
    const remoteEdited = { ...base, athletes: [base.athletes[0], ath('athlete-max-1', 'Max', '11:00')] };
    expect(merge3(base, local, remoteEdited).athletes.map((a) => `${a.name} ${a.start}`)).toEqual(['Jan 10:00', 'Max 11:00']);
    // Remote gelöscht, lokal unverändert → weg
    expect(merge3(base, base, local).athletes.map((a) => a.name)).toEqual(['Jan']);
  });

  test('Beide ändern denselben Athleten → die eigene Änderung gewinnt; Strecke nur von der Seite, die sie geändert hat', () => {
    const base = baseEvent();
    const local = { ...base, athletes: [ath('athlete-jan-1', 'Jan', '10:30'), base.athletes[1]] };
    const remote = { ...base, athletes: [ath('athlete-jan-1', 'Jan', '09:45'), base.athletes[1]], legs: [{ ...base.legs[0], discipline: 'lauf' as const }] };
    const m = merge3(base, local, remote);
    expect(m.athletes[0].start).toBe('10:30');
    expect(m.legs[0].discipline).toBe('lauf');
  });

  test('Ohne bekannten Ausgangsstand: Server gilt, nur lokal eingetragene Athleten bleiben', () => {
    const base = baseEvent();
    const local = { ...base, athletes: [...base.athletes, ath('athlete-nils-1', 'Nils')] };
    const remote = { ...base, athletes: [ath('athlete-jan-1', 'Jan', '13:00')] };
    // (Max fehlt auf dem Server – ob gelöscht oder nie hochgeladen, ist ohne Ausgangsstand nicht zu
    // unterscheiden; lieber behalten als verlieren)
    expect(keepLocalOnly(remote, local).athletes.map((a) => `${a.name} ${a.start}`)).toEqual(['Jan 13:00', 'Max 10:00', 'Nils 10:00']);
  });

  test('Vergleich nach Inhalt ist stabil über Kodieren/Dekodieren (kein Hin-und-her zwischen Geräten)', async () => {
    const ev = baseEvent();
    const back = { ...(await decodeEvent(await encodeEvent(ev))), id: ev.id };
    expect(canonical(back)).toBe(canonical(ev));
  });
});

// ---------------------------------------------------------------- Oberfläche (zwei Geräte)

async function device(browser: Browser, info: TestInfo, store: BackendStore): Promise<Page> {
  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await mockBackend(page, store);
  await page.clock.setFixedTime(new Date('2026-08-23T09:00:00+02:00'));
  return page;
}

async function addAthlete(page: Page, name: string, start = '10:00') {
  await expect(page.locator('body.has-event')).toHaveCount(1); // Strecke fertig geladen
  await openSection(page, 'Athleten');
  await page.getByRole('button', { name: 'Athlet hinzufügen' }).click();
  const d = page.locator('#athlete-dialog');
  await d.getByLabel('Name des Athleten').fill(name);
  await d.getByLabel('Startzeit').fill(start);
  await d.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#toast')).toHaveText(`${name} hinzugefügt.`);
}

/** Abgleich anstoßen wie beim Zurückkehren in die App (statt 20 s zu warten). */
async function sync(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

const names = (page: Page) => page.getByTestId('athlete').locator('.athlete-name');

test('Änderungen kommen bei allen mit dem Link an – ohne neuen Link, auch gleichzeitige', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  const a = await device(browser, info, store);
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(a, 'Jan');

  // Vor dem Teilen bleibt alles auf dem Gerät
  await a.waitForTimeout(1600);
  expect(store.events.size).toBe(0);
  await openSection(a, 'Strecke');
  await expect(a.getByTestId('live-hint')).toContainText('Mit „Link teilen“');
  await a.getByRole('button', { name: 'Link teilen' }).click();
  await expect(a.getByTestId('share-link')).toHaveValue(/#e=[A-Za-z0-9_-]+$/);
  const link = await a.getByTestId('share-link').inputValue();
  await a.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect.poll(() => store.events.size).toBe(1);
  await expect(a.getByTestId('live-hint')).toContainText('Live geteilt');

  const b = await device(browser, info, store);
  await openApp(b, new URL(link).hash);
  await openSection(b, 'Athleten');
  await expect(names(b)).toHaveText(['Jan']);

  // A ergänzt Max – B bekommt ihn ohne neuen Link
  await addAthlete(a, 'Max', '10:05');
  // Eigene Änderungen gehen nach gut einer Sekunde raus (nicht erst beim nächsten 20-s-Abgleich)
  await expect.poll(async () => [...store.events.values()][0].version, { timeout: 4_000 }).toBe(2);
  await sync(b);
  await expect(names(b)).toHaveText(['Jan', 'Max']);
  await expect(b.locator('#toast')).toHaveText('Event wurde von jemand anderem aktualisiert.');

  // B benennt das Rennen um (Strecke/Startnummer) – A sieht es
  await b.locator('#event-name').fill('Heide-Runde live');
  await b.locator('#event-name').press('Enter');
  await expect.poll(async () => (await decodeEvent([...store.events.values()][0].data)).name, { timeout: 10_000 }).toBe('Heide-Runde live');
  await sync(a);
  await expect(a.locator('#event-name')).toHaveValue('Heide-Runde live');

  // Gleichzeitig: A fügt Lisa hinzu, B fügt Tom hinzu – am Ende haben beide alle vier
  await addAthlete(a, 'Lisa', '10:10');
  await addAthlete(b, 'Tom', '10:15');
  await a.waitForTimeout(2500);
  await sync(a);
  await sync(b);
  await a.waitForTimeout(1500);
  await sync(a);
  await sync(b);
  for (const p of [a, b]) {
    await openSection(p, 'Athleten');
    await expect.poll(async () => (await names(p).allTextContents()).sort(), { timeout: 15_000 }).toEqual(['Jan', 'Lisa', 'Max', 'Tom']);
  }
  const server = await decodeEvent([...store.events.values()][0].data);
  expect(server.athletes.map((x) => x.name).sort()).toEqual(['Jan', 'Lisa', 'Max', 'Tom']);
  await a.context().close();
  await b.context().close();
});

test('Alter Link: der Server ist die gemeinsame Wahrheit', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  const a = await device(browser, info, store);
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(a, 'Jan');
  await openSection(a, 'Strecke');
  await a.getByRole('button', { name: 'Link teilen' }).click();
  await expect(a.getByTestId('share-link')).toHaveValue(/#e=/);
  const oldLink = await a.getByTestId('share-link').inputValue();
  await a.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect.poll(() => store.events.size).toBe(1);
  // Danach: Jan entfernt? Nein – Startzeit geändert und Max ergänzt
  await addAthlete(a, 'Max');
  await expect.poll(async () => (await decodeEvent([...store.events.values()][0].data)).athletes.length, { timeout: 10_000 }).toBe(2);

  // Jemand öffnet den ALTEN Link (nur Jan drin) → bekommt trotzdem den aktuellen Stand
  const b = await device(browser, info, store);
  await openApp(b, new URL(oldLink).hash);
  await openSection(b, 'Athleten');
  await expect(names(b)).toHaveText(['Jan', 'Max']);
  await a.context().close();
  await b.context().close();
});

test('Neue Strecke bekommt eine zufällige Kennung (gleiche GPX-Datei bei zwei Leuten ≠ gleiches Event)', async ({ page }) => {
  await openApp(page);
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await openSection(page, 'Strecke');
  await page.getByRole('button', { name: 'Link teilen' }).click();
  await expect(page.getByTestId('share-link')).toHaveValue(/#e=/);
  const id1 = (await decodeEvent(new URL(await page.getByTestId('share-link').inputValue()).hash.slice(3))).id;
  await page.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();
  const token1 = await page.getByTestId('share-link').inputValue();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Anderes Rennen laden' }).click();
  await expect(page.getByRole('heading', { name: 'Welches Rennen schaust du?' })).toBeVisible();
  await page.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await openSection(page, 'Strecke');
  await page.getByRole('button', { name: 'Link teilen' }).click();
  await expect(page.getByTestId('share-link')).not.toHaveValue(token1);
  const id2 = (await decodeEvent(new URL(await page.getByTestId('share-link').inputValue()).hash.slice(3))).id;
  expect(id1).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(id2).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(id2).not.toBe(id1);
});

test('Server erst später erreichbar (z. B. SQL noch nicht ausgeführt): Warnung, und danach verliert niemand Athleten', async ({ browser }, info) => {
  test.slow();
  const store = newBackendStore();
  store.eventsMissing = true;
  const a = await device(browser, info, store);
  await openApp(a);
  await a.locator('#file-input').setInputFiles(fixture('radrennen-lueneburg.gpx'));
  await addAthlete(a, 'Jan');
  await openSection(a, 'Strecke');
  await a.getByRole('button', { name: 'Link teilen' }).click();
  await expect(a.getByTestId('share-link')).toHaveValue(/#e=/);
  const link = await a.getByTestId('share-link').inputValue();
  await a.locator('#share-dialog').getByRole('button', { name: 'Schließen' }).click();
  await addAthlete(a, 'Nils', '10:05');
  // Deutlich sichtbar: unten in der Leiste
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await expect(a.getByTestId('sync-warn')).toContainText('Nicht synchron');

  const b = await device(browser, info, store);
  await openApp(b, new URL(link).hash);
  await addAthlete(b, 'Lisa', '10:10');
  expect(store.events.size).toBe(0);

  // Funktionen jetzt da → beim nächsten Abgleich kommt alles zusammen
  store.eventsMissing = false;
  for (let i = 0; i < 3; i++) {
    await sync(a);
    await a.waitForTimeout(1500);
    await sync(b);
    await b.waitForTimeout(1500);
  }
  for (const p of [a, b]) {
    await openSection(p, 'Athleten');
    await expect.poll(async () => (await names(p).allTextContents()).sort(), { timeout: 15_000 }).toEqual(['Jan', 'Lisa', 'Nils']);
  }
  const server = await decodeEvent([...store.events.values()][0].data);
  expect(server.athletes.map((x) => x.name).sort()).toEqual(['Jan', 'Lisa', 'Nils']);
  await a.getByRole('button', { name: 'Athleten schließen' }).click();
  await expect(a.getByTestId('sync-warn')).toHaveCount(0);
  await a.context().close();
  await b.context().close();
});
