import { test, expect } from '@playwright/test';
import { legDistance } from '../src/course';
import { clock, parseMmss } from '../src/format';
import type { Athlete, Leg, Point, RaceEvent } from '../src/model';
import { planAt, timeAtAlong, timeline } from '../src/schedule';
import { decodeEvent, encodeEvent, eventFromWire } from '../src/share';

/*
 * Reine Logik-Tests für den Zeitplan (laufen ohne Browser-Seite).
 * Strecken sind gerade Nord-Süd-Linien mit exakt bekannter Länge.
 */

const line = (lat0: number, km: number): Point[] =>
  Array.from({ length: 101 }, (_, i) => ({ lat: lat0 + ((km / 111.195) * i) / 100, lng: 10 }));
const leg = (name: string, discipline: Leg['discipline'], lat0: number, km: number): Leg => ({
  name,
  discipline,
  points: line(lat0, km),
  elevationGain: null,
});

const tri: RaceEvent = {
  name: 'Tri',
  date: '2026-08-23',
  athletes: [],
  legs: [leg('Swim', 'schwimmen', 53, 1.5), leg('Bike', 'rad', 53.1, 40), leg('Run', 'lauf', 53.6, 10)],
};
const jan: Athlete = {
  name: 'Jan',
  color: '#d62839',
  start: '09:00',
  pace: { schwimmen: 120, rad: 30, lauf: 330 },
  transition: 180,
};
const at = (hhmm: string) => new Date(`2026-08-23T${hhmm}:00`).getTime();
const today = new Date('2026-08-23T08:00:00');

test.beforeAll(() => {
  // Plausibilität der Test-Strecken
  expect(legDistance(tri.legs[1]) / 1000).toBeCloseTo(40, 2);
});

test('Triathlon: Zeitplan aus Pace je Disziplin und Wechselzeiten', () => {
  const tl = timeline(tri, jan, today);
  // 30 min Schwimmen + 3 + 80 min Rad + 3 + 55 min Lauf = 171 min
  expect((tl.finish - tl.start) / 60_000).toBeCloseTo(171, 1);
  expect(clock(tl.start)).toBe('09:00');
  expect(clock(tl.finish)).toBe('11:51');
  expect(tl.segments.map((s) => s.kind)).toEqual(['leg', 'wechsel', 'leg', 'wechsel', 'leg']);
});

test('Position laut Plan zu verschiedenen Zeiten', () => {
  const tl = timeline(tri, jan, today);
  expect(planAt(tri, tl, at('08:59')).state).toBe('vor-start');

  const swim = planAt(tri, tl, at('09:15'));
  expect(swim.state === 'unterwegs' && swim.legIndex).toBe(0);
  expect(swim.state === 'unterwegs' && swim.along).toBeCloseTo(750, -1);

  const t1 = planAt(tri, tl, at('09:31'));
  expect(t1.state === 'unterwegs' && t1.inTransition).toBe(true);

  const bike = planAt(tri, tl, at('10:00')); // 27 min Rad mit 30 km/h = 13,5 km
  expect(bike.state === 'unterwegs' && bike.legIndex).toBe(1);
  expect(bike.state === 'unterwegs' && bike.along).toBeCloseTo(15_000, -1);

  expect(planAt(tri, tl, at('12:00')).state).toBe('im-ziel');
});

test('Durchgangszeit an einer Stelle der Strecke', () => {
  const tl = timeline(tri, jan, today);
  expect(clock(timeAtAlong(tl, 0))).toBe('09:00');
  expect(clock(timeAtAlong(tl, 21_500))).toBe('10:13'); // Rad-km 20 → 09:33 + 40 min
  expect(clock(timeAtAlong(tl, 51_500))).toBe('11:51'); // Ziel
});

test('Eigene Wechsel-Etappe dauert die Wechselzeit, kein doppelter Wechsel', () => {
  const ev: RaceEvent = {
    ...tri,
    legs: [tri.legs[0], leg('T1', 'wechsel', 53.05, 0.3), tri.legs[1]],
  };
  const tl = timeline(ev, jan, today);
  expect(tl.segments.map((s) => s.kind)).toEqual(['leg', 'leg', 'leg']);
  expect((tl.finish - tl.start) / 60_000).toBeCloseTo(30 + 3 + 80, 1);
});

test('Ohne Renntag gilt der heutige Tag', () => {
  const tl = timeline({ ...tri, date: null }, jan, new Date('2026-09-01T07:00:00'));
  expect(new Date(tl.start).toISOString()).toBe(new Date('2026-09-01T09:00:00').toISOString());
});

test('Pace-Eingaben werden verstanden', () => {
  expect(parseMmss('5:30')).toBe(330);
  expect(parseMmss('5')).toBe(300);
  expect(parseMmss('5,5')).toBe(330);
  expect(parseMmss('2:05')).toBe(125);
  expect(parseMmss('5:75')).toBeNull();
  expect(parseMmss('abc')).toBeNull();
  expect(parseMmss('')).toBeNull();
});

test('Teilen-Link: Athleten und Renntag gehen hin und zurück', async () => {
  const ev = { ...tri, athletes: [jan, { ...jan, name: 'Max', color: '#1d4ed8', pace: { schwimmen: 105, rad: 33.5, lauf: 285 } }] };
  const back = await decodeEvent(await encodeEvent(ev));
  expect(back.date).toBe('2026-08-23');
  expect(back.athletes).toEqual(ev.athletes);
});

test('Alte Links ohne Athleten funktionieren weiter', () => {
  const ev = eventFromWire({ v: 1, n: 'Alt', l: [] });
  expect(ev.athletes).toEqual([]);
  expect(ev.date).toBeNull();
});

test('Manipulierte Athleten im Link werden abgelehnt', () => {
  const bad = { v: 1, n: 'X', l: [], a: [{ n: 'X', c: 'red;background:url(x)', s: '9:00', p: [1, 2, 3], w: 0 }] };
  expect(() => eventFromWire(bad)).toThrow('Athlet im Link ist beschädigt');
});
