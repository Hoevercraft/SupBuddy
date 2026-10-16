import { test, expect } from '@playwright/test';
import { candidates, estimateTravel, nogoLines, planStops, ARRIVAL_BUFFER_MS } from '../src/cheer';
import { legDistance } from '../src/course';
import { haversine } from '../src/geo';
import type { Athlete, Leg, Point, RaceEvent } from '../src/model';
import { appleMapsUrl, googleMapsUrl, routeUrl, viaPoints, type Route } from '../src/routing';
import { nearestOnPath } from '../src/geo';
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

test('Navi-Links: Ziel, Verkehrsmittel und Zwischenziele', () => {
  const p = { lat: 53.30031, lng: 10.41172 };
  const via = [{ lat: 53.29, lng: 10.4 }, { lat: 53.28, lng: 10.39 }];
  expect(googleMapsUrl(p, 'rad')).toBe('https://www.google.com/maps/dir/?api=1&destination=53.300310,10.411720&travelmode=bicycling');
  expect(googleMapsUrl(p, 'fuss', via)).toBe(
    'https://www.google.com/maps/dir/?api=1&destination=53.300310,10.411720&travelmode=walking&waypoints=53.290000,10.400000%7C53.280000,10.390000',
  );
  expect(appleMapsUrl(p, 'rad', via)).toBe(
    'https://maps.apple.com/directions?destination=53.300310,10.411720&waypoint=53.290000,10.400000&waypoint=53.280000,10.390000&mode=cycling',
  );
  expect(appleMapsUrl(p, 'fuss')).toBe('https://maps.apple.com/directions?destination=53.300310,10.411720&mode=walking');
  expect(appleMapsUrl(p, 'scooter')).toContain('mode=cycling');
  // Nie mehr als 3 Zwischenziele (Grenze von Google Maps im Handy-Browser)
  const many = Array.from({ length: 6 }, (_, i) => ({ lat: 53 + i / 100, lng: 10 }));
  expect(googleMapsUrl(p, 'rad', many).split('%7C')).toHaveLength(3);
  expect(appleMapsUrl(p, 'rad', many).match(/waypoint=/g)).toHaveLength(3);
});

test('Zwischenziele liegen gleichmäßig auf der berechneten Route', () => {
  // L-förmiger Weg: 4 km nach Norden, dann 4 km nach Osten (Navi würde diagonal abkürzen)
  const north = Array.from({ length: 41 }, (_, i) => ({ lat: 53 + (4 / 111.195) * (i / 40), lng: 10 }));
  const corner = north[40];
  const east = Array.from({ length: 41 }, (_, i) => ({ lat: corner.lat, lng: 10 + (4 / (111.195 * Math.cos((corner.lat * Math.PI) / 180))) * (i / 40) }));
  const route: Route = { points: [...north, ...east.slice(1)], distance: 8000, routed: true };
  const via = viaPoints(route);
  expect(via).toHaveLength(3);
  for (const v of via) expect(nearestOnPath(route.points, v)!.distance).toBeLessThan(5);
  const along = via.map((v) => nearestOnPath(route.points, v)!.along);
  expect(along[0]).toBeCloseTo(2000, -2);
  expect(along[1]).toBeCloseTo(4000, -2); // genau an der Ecke
  expect(along[2]).toBeCloseTo(6000, -2);
});

test('Keine Zwischenziele bei kurzen oder nur geschätzten Wegen', () => {
  const short: Route = { points: line(53, 0.5).slice(0, 101), distance: 250, routed: true };
  expect(viaPoints(short)).toEqual([]);
  const est: Route = { points: [{ lat: 53, lng: 10 }, { lat: 53.1, lng: 10 }], distance: 11_000, routed: false };
  expect(viaPoints(est)).toEqual([]);
  const mid: Route = { points: line(53, 1.2), distance: 1200, routed: true };
  expect(viaPoints(mid)).toHaveLength(1);
});

// ---------------------------------------------------------------- Queren der Strecke

import { crossesCourse } from '../src/cheer';
import { buildPlan } from '../src/plan';

/** Strecke: gerade West→Ost bei lat 53,0 (10 km). */
const ostWest: RaceEvent = {
  name: 'OW',
  date: '2026-08-23',
  athletes: [jan],
  legs: [{ name: 'Rad', discipline: 'rad', elevationGain: null, points: Array.from({ length: 101 }, (_, i) => ({ lat: 53, lng: 10 + (0.15 * i) / 100 })) }],
};
const dLat = (m: number) => m / 111_195; // Meter → Grad Breite

test('Ankommen von der Seite und an der Strecke entlang ist kein Queren', () => {
  // Von Süden an die Strecke, dann 300 m an ihr entlang zum Ziel (Jans Fall bei Altenmedingen)
  const route = [
    { lat: 53 - dLat(2000), lng: 10.05 },
    { lat: 53 - dLat(5), lng: 10.05 },
    { lat: 53 - dLat(5), lng: 10.0545 },
  ];
  expect(crossesCourse(ostWest, route)).toBe(false);
});

test('Von Süden nach Norden über die Strecke = Queren', () => {
  const route = [
    { lat: 53 - dLat(1500), lng: 10.05 },
    { lat: 53 + dLat(1500), lng: 10.05 },
    { lat: 53 + dLat(1500), lng: 10.1 },
    { lat: 53 + dLat(5), lng: 10.1 },
  ];
  expect(crossesCourse(ostWest, route)).toBe(true);
});

test('Seitenwechsel direkt am Ziel zählt nicht (man will ja an die Strecke)', () => {
  const route = [
    { lat: 53 - dLat(1500), lng: 10.05 },
    { lat: 53 - dLat(50), lng: 10.05 },
    { lat: 53 + dLat(60), lng: 10.05 },
  ];
  expect(crossesCourse(ostWest, route)).toBe(false);
});

test('Wege abseits der Strecke queren nichts; Schwimmen zählt nicht', () => {
  const far = [{ lat: 53.2, lng: 10.0 }, { lat: 53.3, lng: 10.2 }];
  expect(crossesCourse(ostWest, far)).toBe(false);
  const swim: RaceEvent = { ...ostWest, legs: [{ ...ostWest.legs[0], discipline: 'schwimmen' }] };
  expect(crossesCourse(swim, [{ lat: 53 - dLat(1500), lng: 10.05 }, { lat: 53 + dLat(1500), lng: 10.05 }])).toBe(false);
});

test('Routing: direkter Weg ohne Queren wird ohne Sperrlinien genommen', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const coords = [[10.05, 53 - dLat(2000)], [10.05, 53 - dLat(5)], [10.0545, 53 - dLat(5)]];
    return new Response(JSON.stringify({ features: [{ properties: { 'track-length': '2300' }, geometry: { coordinates: coords } }] }));
  }) as typeof fetch;
  try {
    const { fetchRoute } = await import('../src/routing');
    const r = await fetchRoute(ostWest, { lat: 53 - dLat(2000), lng: 10.05 }, { lat: 53, lng: 10.0545 }, 'fuss');
    expect(r?.distance).toBe(2300);
    expect(r?.crosses).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('polylines');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Routing: querender Weg → neu mit Sperrlinien; geht das nicht, wird Queren markiert', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const crossing = [[10.05, 53 - dLat(1500)], [10.05, 53 + dLat(1500)], [10.1, 53 + dLat(1500)], [10.1, 53 + dLat(5)]];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('polylines')) return new Response('target island detected for section 0', { status: 400 });
    return new Response(JSON.stringify({ features: [{ properties: { 'track-length': '6000' }, geometry: { coordinates: crossing } }] }));
  }) as typeof fetch;
  try {
    const { fetchRoute } = await import('../src/routing');
    const r = await fetchRoute(ostWest, { lat: 53 - dLat(1500), lng: 10.05 }, { lat: 53 + dLat(5), lng: 10.1 }, 'rad');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('polylines');
    expect(r?.crosses).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Nachplanen: ein einzelner extremer Umweg leert den Plan nicht (Jans Fall)', async () => {
  // Läufer-Strecke; der erste angefragte Weg ist absurd lang (×6), alle anderen normal (×1,3)
  const ev: RaceEvent = { ...lauf, athletes: [{ ...jan, start: '10:00' }] };
  const start = { lat: 53 + 5 / 111.195, lng: 10.02 }; // ~1,3 km neben km 5
  let first = true;
  const fetcher = async (a: Point, b: Point) => {
    const f = first ? 6 : 1.3;
    first = false;
    return { points: [a, b], distance: haversine(a, b) * f, routed: true };
  };
  const plan = await buildPlan(ev, { athleteIndex: 0, mode: 'fuss', speed: 4.5, maxStops: 1 }, start, at('09:50'), fetcher);
  expect(plan.stops.length).toBe(1);
  expect(plan.stops[0].tight).toBe(false);
});

test('Knappe Stopps am Ende werden abgeschnitten, sichere bleiben', async () => {
  const ev: RaceEvent = { ...lauf, athletes: [{ ...jan, start: '10:00', pace: { ...jan.pace, lauf: 390 } }] };
  const start = { lat: 53 + 2 / 111.195, lng: 10.015 };
  // Erster Weg normal, alle weiteren extrem lang → nach dem ersten Stopp geht nichts mehr sicher
  let n = 0;
  const fetcher = async (a: Point, b: Point) => ({ points: [a, b], distance: haversine(a, b) * (n++ === 0 ? 1.3 : 20), routed: true });
  const plan = await buildPlan(ev, { athleteIndex: 0, mode: 'rad', speed: 15, maxStops: 3 }, start, at('09:50'), fetcher);
  expect(plan.stops.length).toBeGreaterThanOrEqual(1);
  expect(plan.stops.every((s) => !s.tight)).toBe(true);
});
