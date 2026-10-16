import type { Point } from './model';

const R = 6_371_000; // Erdradius in m
const toRad = (d: number) => (d * Math.PI) / 180;

/** Großkreisdistanz in Metern. */
export function haversine(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Gesamtlänge in Metern. */
export function pathLength(points: Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversine(points[i - 1], points[i]);
  return sum;
}

/** Punkt nach `distance` Metern entlang des Linienzugs (an den Enden begrenzt). */
export function pointAtDistance(points: Point[], distance: number): Point {
  if (points.length === 0) throw new Error('Leerer Linienzug');
  if (distance <= 0) return points[0];
  let rest = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversine(a, b);
    if (rest <= d) {
      const t = d === 0 ? 0 : rest / d;
      return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
    }
    rest -= d;
  }
  return points[points.length - 1];
}

/**
 * Positive Höhenmeter mit einfacher Glättung (Schwelle),
 * damit GPS-Rauschen nicht aufsummiert wird.
 */
export function elevationGain(points: Point[], threshold = 3): number | null {
  const eles = points.map((p) => p.ele).filter((e): e is number => typeof e === 'number');
  if (eles.length < 2) return null;
  let gain = 0;
  let ref = eles[0];
  for (const e of eles) {
    if (e - ref >= threshold) {
      gain += e - ref;
      ref = e;
    } else if (ref - e >= threshold) {
      ref = e;
    }
  }
  return gain;
}

export type Bounds = [[number, number], [number, number]];

export function bounds(points: Point[]): Bounds | null {
  if (points.length === 0) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

/** Lokale Projektion in Metern relativ zu einem Referenzpunkt (für kurze Distanzen genau genug). */
function project(p: Point, ref: Point): [number, number] {
  const x = toRad(p.lng - ref.lng) * Math.cos(toRad(ref.lat)) * R;
  const y = toRad(p.lat - ref.lat) * R;
  return [x, y];
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker mit Toleranz in Metern (iterativ, kein Rekursionslimit). */
export function simplify(points: Point[], toleranceM = 5): Point[] {
  if (points.length <= 2) return points.slice();
  const ref = points[0];
  const xy = points.map((p) => project(p, ref));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(xy[i], xy[s], xy[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export interface Nearest {
  /** Abstand zum nächsten Punkt auf der Strecke in m */
  distance: number;
  /** Position entlang der Strecke in m ab Start */
  along: number;
  point: Point;
}

/** Nächster Punkt auf einem Linienzug (mit Projektion auf die Segmente). */
export function nearestOnPath(points: Point[], p: Point): Nearest | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { distance: haversine(points[0], p), along: 0, point: points[0] };
  const q = project(p, p); // = [0,0]
  let best: Nearest | null = null;
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = haversine(a, b);
    const pa = project(a, p);
    const pb = project(b, p);
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - pa[0]) * dx + (q[1] - pa[1]) * dy) / len2));
    const d = Math.hypot(pa[0] + t * dx, pa[1] + t * dy);
    if (!best || d < best.distance) {
      best = {
        distance: d,
        along: along + t * segLen,
        point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
      };
    }
    along += segLen;
  }
  return best;
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : formatKm(m);
}

export function formatKm(m: number): string {
  return `${(m / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}
