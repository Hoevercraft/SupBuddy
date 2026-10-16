import { test, expect } from '@playwright/test';
import { candidates, estimateTravel, nogoLines, planStops, ARRIVAL_BUFFER_MS } from '../src/cheer';
import { legDistance } from '../src/course';
import { haversine } from '../src/geo';
import type { Athlete, Leg, Point, RaceEvent } from '../src/model';
import { appleMapsUrl, googleMapsUrl, routeUrl } from '../src/routing';
import { timeline } from '../src/schedule';

/* Reine Logik-Tests für den Anfeuer-Plan. */

const line = (lat0: number, km: number): Point[] =>
  Array.from({ length: 201 }, (_, i) => ({ lat: lat0 + ((km / 111.195) * i) / 200, lng: 10 }));
const leg = (discipline: Leg['discipline'], lat0: number, km: number): Leg => ({ name: discipline, discipline, points: line(lat0, km), elevationGain: null });
const jan: Athlete = { name: 'Jan', color: '#d62839', start: '10:00', pace: { schwimmen: 120, rad: 30, lauf: 330 }, transition: 180 };
const rad: RaceEvent = { name: 'Rad', date: '2026-08-23', athletes: [jan], legs: [leg('rad', 53, 40)] };
const at = (hhmm: string) => new Date(`2026-08-23T${hhmm}:00`).getTime();
const today = new Date('2026-08-23T08:00:00');

test('Kandidaten: gleichmäßig entlang der Strecke, mit Start und Ziel', () => {
  const c = candidates(rad);
  expect(c[0].along).toBe(0);
  expect(c[c.length - 1].along).toBeCloseTo(40_000, -2);
  const gaps = c.slice(1).map((x, i) => x.along - c[i].along);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(2000 + 1);
  expect(new Set(c.map((x) => x.id)).size).toBe(c.length);
});

test('Kandidaten: beim Schwimmen nur Ein- und Ausstieg', () => {
  const tri: RaceEvent = { ...rad, legs: [leg('schwimmen', 53, 1.5), leg('rad', 53.02, 40)] };
  const swim = candidates(tri).filter((c) => c.legIndex === 0);
  expect(swim.map((c) => Math.round(c.along))).toEqual([0, 1500]);
});

const lauf: RaceEvent = { name: 'Lauf', date: '2026-08-23', athletes: [jan], legs: [leg('lauf', 53, 21.1)] };

test('Gerade Strecke: schnellen Radfahrer sieht man mit dem Rad nur einmal', () => {
  // 30 km/h Athlet vs. 15 km/h Supporter: ist er vorbei, holt man ihn nicht mehr ein
  const stops = planStops({
    candidates: candidates(rad),
    timeline: timeline(rad, jan, today),
    start: { lat: 53 + 2 / 111.195, lng: 10.015 },
    startTime: at('09:50'),
    maxStops: 3,
    travel: estimateTravel(15),
  });
  expect(stops.length).toBe(1);
});

test('Plan: jeder Stopp ist rechtzeitig vor dem Athleten erreichbar', () => {
  // Halbmarathon, 6:30 min/km (~9,2 km/h); Supporter 1 km neben km 2, Rad mit 15 km/h.
  // (Bei 5:30 min/km wäre das Rad mit Umweg effektiv kaum schneller als der Läufer.)
  const tl = timeline(lauf, { ...jan, pace: { ...jan.pace, lauf: 390 } }, today);
  const start = { lat: 53 + 2 / 111.195, lng: 10.015 };
  const travel = estimateTravel(15);
  const stops = planStops({ candidates: candidates(lauf), timeline: tl, start, startTime: at('09:50'), maxStops: 3, travel });
  expect(stops.length).toBeGreaterThanOrEqual(2);
  let pos = start;
  let time = at('09:50');
  for (const s of stops) {
    const arrive = time + travel(pos, s.candidate.point) * 1000;
    expect(arrive + ARRIVAL_BUFFER_MS).toBeLessThanOrEqual(s.pass);
    pos = s.candidate.point;
    time = s.depart;
  }
  // Stopps liegen in Fahrtrichtung hintereinander, mit Mindestabstand
  for (let i = 1; i < stops.length; i++) expect(stops[i].candidate.along - stops[i - 1].candidate.along).toBeGreaterThanOrEqual(1500);
});

test('Plan: zu weit weg → keine Stopps', () => {
  const tl = timeline(rad, jan, today);
  const far = { lat: 53.2, lng: 10.6 }; // ~40 km entfernt
  const stops = planStops({ candidates: candidates(rad), timeline: tl, start: far, startTime: at('09:50'), maxStops: 3, travel: estimateTravel(4.5) });
  expect(stops).toEqual([]);
});

test('Plan: Wunschanzahl wird nicht überschritten', () => {
  const tl = timeline(lauf, jan, today);
  const stops = planStops({ candidates: candidates(lauf), timeline: tl, start: lauf.legs[0].points[0], startTime: at('08:00'), maxStops: 2, travel: estimateTravel(18) });
  expect(stops.length).toBe(2);
  const three = planStops({ candidates: candidates(lauf), timeline: tl, start: lauf.legs[0].points[0], startTime: at('08:00'), maxStops: 3, travel: estimateTravel(18) });
  expect(three.length).toBe(3);
});

test('Sperrlinien: Strecke gesperrt, aber Fenster um Start und Ziel des Weges offen', () => {
  const target = rad.legs[0].points[100]; // km 20
  const lines = nogoLines(rad, [target]);
  expect(lines.length).toBe(2); // Strecke vor und nach dem Fenster
  for (const l of lines) for (const p of l) expect(haversine(p, target)).toBeGreaterThanOrEqual(200);
  // Lückenlos bis kurz vors Fenster (keine lange Gerade überbrückt das Ziel)
  const nearest = Math.min(...lines.flat().map((p) => haversine(p, target)));
  expect(nearest).toBeLessThan(320);
});

test('Schwimm-Etappe sperrt nichts', () => {
  const tri: RaceEvent = { ...rad, legs: [leg('schwimmen', 53, 1.5)] };
  expect(nogoLines(tri, [])).toEqual([]);
});

test('Routing-URL: Profil je Fortbewegung, Sperrlinien dabei, nicht zu lang', () => {
  const long: RaceEvent = { ...rad, legs: [leg('rad', 53, 180)] };
  const from = { lat: 53.5, lng: 10.02 };
  const to = long.legs[0].points[60];
  const url = routeUrl(long, from, to, 'fuss');
  expect(url).toContain('profile=shortest');
  expect(url).toContain('&polylines=');
  expect(url.length).toBeLessThanOrEqual(7000);
  expect(routeUrl(long, from, to, 'rad')).toContain('profile=trekking');
  expect(legDistance(long.legs[0])).toBeGreaterThan(170_000);
});

test('Navi-Links', () => {
  const p = { lat: 53.30031, lng: 10.41172 };
  expect(googleMapsUrl(p, 'rad')).toBe('https://www.google.com/maps/dir/?api=1&destination=53.300310,10.411720&travelmode=bicycling');
  expect(googleMapsUrl(p, 'fuss')).toContain('travelmode=walking');
  expect(appleMapsUrl(p, 'fuss')).toBe('https://maps.apple.com/?daddr=53.300310,10.411720&dirflg=w');
});
