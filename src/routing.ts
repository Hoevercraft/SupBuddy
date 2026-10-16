import { MODES, nogoLines, type Mode } from './cheer';
import { haversine } from './geo';
import type { Point, RaceEvent } from './model';

/*
 * Wege über BRouter (brouter.de, ohne API-Key). Die Rennstrecke wird als Sperrlinie
 * übergeben, damit der Weg sie nicht quert. Die Dauer rechnen wir selbst aus Weglänge
 * und dem Tempo des Supporters – BRouters eigene Zeit passt nicht zu jedem Tempo.
 */

export const BROUTER_URL = 'https://brouter.de/brouter';
/** Längere URLs lehnen manche Server ab → Sperrlinien dann gröber vereinfachen. */
const MAX_URL = 7000;

export interface Route {
  points: Point[];
  /** Weglänge in m */
  distance: number;
  /** true = echte Route, false = Schätzung (Luftlinie × Umweg) */
  routed: boolean;
}

const fmt = (p: Point) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;

export function routeUrl(ev: RaceEvent, from: Point, to: Point, mode: Mode): string {
  for (const tolerance of [40, 80, 160, 320]) {
    const lines = nogoLines(ev, [from, to], 200, tolerance, { from, to });
    const params = new URLSearchParams({
      lonlats: `${fmt(from)}|${fmt(to)}`,
      profile: MODES[mode].profile,
      alternativeidx: '0',
      format: 'geojson',
    });
    let url = `${BROUTER_URL}?${params.toString().replace(/%2C/g, ',').replace(/%7C/g, '|')}`;
    if (lines.length) url += `&polylines=${lines.map((l) => l.map(fmt).join(',')).join('|')}`;
    if (url.length <= MAX_URL) return url;
  }
  // Notfalls ohne Sperrlinien
  return `${BROUTER_URL}?lonlats=${fmt(from)}|${fmt(to)}&profile=${MODES[mode].profile}&alternativeidx=0&format=geojson`;
}

/** Echte Route holen; bei Fehler oder Zeitüberschreitung null. */
export async function fetchRoute(ev: RaceEvent, from: Point, to: Point, mode: Mode, timeoutMs = 15_000): Promise<Route | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(routeUrl(ev, from, to, mode), { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const f = data?.features?.[0];
    const coords: unknown = f?.geometry?.coordinates;
    const length = Number(f?.properties?.['track-length']);
    if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(length)) return null;
    const points = coords
      .filter((c): c is number[] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => ({ lng: c[0], lat: c[1] }));
    return { points, distance: length, routed: true };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ersatz, wenn das Routing nicht erreichbar ist. */
export function estimatedRoute(from: Point, to: Point, detour: number): Route {
  return { points: [from, to], distance: haversine(from, to) * detour, routed: false };
}

/** Navigation in Google Maps (öffnet auf dem Handy die App, sonst die Webseite). */
export function googleMapsUrl(to: Point, mode: Mode): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.lat.toFixed(6)},${to.lng.toFixed(6)}&travelmode=${MODES[mode].google}`;
}

/** Navigation in Apple Karten. */
export function appleMapsUrl(to: Point, mode: Mode): string {
  const flag = mode === 'fuss' ? '&dirflg=w' : '';
  return `https://maps.apple.com/?daddr=${to.lat.toFixed(6)},${to.lng.toFixed(6)}${flag}`;
}
