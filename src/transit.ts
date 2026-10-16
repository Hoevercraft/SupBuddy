import { haversine } from './geo';
import type { Point } from './model';

/*
 * Bus & Bahn über Transitous (api.transitous.org, MOTIS): freier, nicht-kommerzieller
 * Fahrplandienst mit allen deutschen Fahrplänen (DELFI), ohne API-Key, CORS erlaubt.
 * Fällt er aus, schätzt die App (siehe estimateTransitSeconds) und sagt das dazu.
 */

export const TRANSIT_URL = 'https://api.transitous.org/api/v1/plan';

export interface TransitStop {
  name: string;
  /** ms */
  time: number;
  /** DELFI-Kennung, z. B. „de:03355:15072“ (Bundesland + Kreis vorne) */
  stopId?: string;
}

export interface TransitLeg {
  /** WALK, BUS, TRAM, SUBWAY, REGIONAL_RAIL, … */
  mode: string;
  /** Linie, z. B. „5009“, „S3“, „RE3“ */
  line?: string;
  headsign?: string;
  from: TransitStop;
  to: TransitStop;
  points: Point[];
}

export interface Journey {
  /** Abfahrt am Startpunkt (inkl. Fußweg), ms */
  start: number;
  /** Ankunft am Ziel, ms */
  end: number;
  transfers: number;
  legs: TransitLeg[];
}

/** Fahrten mit Bus/Bahn (ohne die Fußwege dazwischen). */
export const rideLegs = (j: Journey) => j.legs.filter((l) => l.mode !== 'WALK');

/** Polyline-Dekodierung (Google-Format, beliebige Genauigkeit; MOTIS nutzt 7 Stellen). */
export function decodePolyline(str: string, precision = 7): Point[] {
  const factor = 10 ** precision;
  const out: Point[] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

/** DELFI-Kennung aus der Transitous-ID („de-DELFI_de:03355:15072::…“ → „de:03355:15072“). */
export function delfiId(stopId: unknown): string | undefined {
  const m = typeof stopId === 'string' ? stopId.match(/de:\d{5}:[^:]+/) : null;
  return m ? m[0] : undefined;
}

export function journeyUrl(from: Point, to: Point, time: number, arriveBy: boolean): string {
  const p = new URLSearchParams({
    fromPlace: `${from.lat.toFixed(6)},${from.lng.toFixed(6)}`,
    toPlace: `${to.lat.toFixed(6)},${to.lng.toFixed(6)}`,
    time: new Date(time).toISOString(),
    arriveBy: String(arriveBy),
    numItineraries: '5',
    // Bis zu 20 min Fußweg zur ersten und von der letzten Haltestelle
    maxPreTransitTime: '1200',
    maxPostTransitTime: '1200',
  });
  return `${TRANSIT_URL}?${p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':')}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseJourney(it: any): Journey | null {
  const start = Date.parse(it?.startTime);
  const end = Date.parse(it?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Array.isArray(it?.legs)) return null;
  const legs: TransitLeg[] = it.legs.map((l: any) => {
    const g = l?.legGeometry;
    const points = typeof g?.points === 'string' ? decodePolyline(g.points, Number(g.precision) || 7) : [];
    const stop = (s: any, key: 'departure' | 'arrival'): TransitStop => ({
      name: String(s?.name ?? ''),
      time: Date.parse(s?.[key] ?? (key === 'departure' ? l.startTime : l.endTime)),
      stopId: delfiId(s?.stopId),
    });
    return {
      mode: String(l?.mode ?? 'WALK'),
      line: l?.routeShortName || l?.displayName || undefined,
      headsign: l?.headsign || undefined,
      from: stop(l?.from, 'departure'),
      to: stop(l?.to, 'arrival'),
      points,
    };
  });
  return { start, end, transfers: Number(it.transfers) || 0, legs };
}

/** Antwort von Transitous in Verbindungen umwandeln (kaputte Einträge fallen weg). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJourneys(data: any): Journey[] | null {
  if (!Array.isArray(data?.itineraries)) return null;
  return data.itineraries.map(parseJourney).filter((j: Journey | null): j is Journey => !!j);
}

/** Verbindungen holen; bei Fehler/Zeitüberschreitung null (→ Schätzung). Ein zweiter Versuch bei Überlast. */
export async function fetchJourneys(from: Point, to: Point, time: number, arriveBy: boolean, timeoutMs = 12_000): Promise<Journey[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(journeyUrl(from, to, time, arriveBy), { signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      if (!res.ok) return null;
      return parseJourneys(await res.json());
    } catch {
      if (ctrl.signal.aborted) return null; // Zeitüberschreitung: nicht noch mal warten
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Beste Verbindung, um zwischen `earliest` und `deadline` anzukommen:
 * möglichst kurze Reisezeit, bei Gleichstand weniger Umstiege.
 * Passt keine, die mit der frühesten Ankunft (für „wird knapp“).
 */
export function chooseJourney(journeys: Journey[], earliest: number, deadline: number): { journey: Journey; inTime: boolean } | null {
  const valid = journeys.filter((j) => j.start >= earliest - 30_000);
  const inTime = valid.filter((j) => j.end <= deadline);
  if (inTime.length) {
    inTime.sort((a, b) => a.end - a.start - (b.end - b.start) || a.transfers - b.transfers);
    return { journey: inTime[0], inTime: true };
  }
  if (!valid.length) return null;
  valid.sort((a, b) => a.end - b.end);
  return { journey: valid[0], inTime: false };
}

/** Grobe Schätzung ohne Fahrplan: zu Fuß oder Bus/Bahn (Wege + Warten + ~20 km/h), was schneller ist. */
export function estimateTransitSeconds(from: Point, to: Point, walkKmh = 4.5): number {
  const d = haversine(from, to) * 1.4;
  const walk = d / (walkKmh / 3.6);
  const ride = 15 * 60 + d / (20 / 3.6);
  return Math.min(walk, ride);
}

/** Kurztext einer Fahrt: „Bus 5009“, „S3“, „RE 3“ … */
export function legLabel(l: TransitLeg): string {
  const kind: Record<string, string> = {
    BUS: 'Bus',
    COACH: 'Bus',
    TRAM: 'Tram',
    SUBWAY: 'U-Bahn',
    FERRY: 'Fähre',
    SUBURBAN: 'S-Bahn',
    REGIONAL_RAIL: 'Zug',
    REGIONAL_FAST_RAIL: 'Zug',
    RAIL: 'Zug',
    HIGHSPEED_RAIL: 'Zug',
    LONG_DISTANCE: 'Zug',
    NIGHT_RAIL: 'Zug',
    METRO: 'U-Bahn',
  };
  const line = l.line?.trim();
  // Linien wie „S3“, „U2“, „RE3“ sprechen für sich
  if (line && /^(S|U|RE|RB|IRE|ICE|IC|EC)\s?\d/i.test(line)) return line;
  return line ? `${kind[l.mode] ?? 'Linie'} ${line}` : (kind[l.mode] ?? 'Fahrt');
}
