import { legDistance } from './course';
import { haversine, pointAtDistance, simplify } from './geo';
import type { Athlete, Point, RaceEvent } from './model';
import { timeAtAlong, timeline, type Timeline } from './schedule';

/*
 * Anfeuer-Plan: Wo kann ich einen Athleten wie oft anfeuern?
 *
 * 1. Kandidaten: Punkte in regelmäßigem Abstand entlang der Strecke (Schwimmen nur Ein-/Ausstieg).
 *    Jeder Kandidat hat seine Position „km ab Start“ – bei Rundkursen ist jede Runde ein eigener Kandidat.
 * 2. Planung: Beam-Suche über Abfolgen von Stopps. Ein Stopp zählt, wenn ich (mit Puffer) vor dem
 *    Athleten dort bin. Weiter geht es, sobald er durch ist. Wegzeiten werden zunächst geschätzt
 *    (Luftlinie × Umwegfaktor), danach mit echten Routen nachgerechnet.
 */

export type Mode = 'fuss' | 'rad' | 'scooter';

export const MODES: Record<Mode, { label: string; verb: string; kmh: number; profile: string; google: string }> = {
  fuss: { label: 'Zu Fuß', verb: 'zu Fuß', kmh: 4.5, profile: 'shortest', google: 'walking' },
  rad: { label: 'Rad', verb: 'mit dem Rad', kmh: 15, profile: 'trekking', google: 'bicycling' },
  scooter: { label: 'E-Scooter', verb: 'mit dem E-Scooter', kmh: 18, profile: 'trekking', google: 'bicycling' },
};

/** Vor dem Athleten da sein: so viel Puffer vor seiner Durchgangszeit. */
export const ARRIVAL_BUFFER_MS = 3 * 60_000;
/** Nach dem Durchgang noch kurz bleiben, dann weiter. */
export const LINGER_MS = 60_000;
/** Umwegfaktor Luftlinie → Weg (für die Schätzung). */
export const DETOUR = 1.4;

export interface Candidate {
  /** Stabile Kennung: Position auf 100 m gerundet (für Sichtungen später) */
  id: string;
  along: number;
  legIndex: number;
  point: Point;
}

/** Kandidaten entlang der Strecke. Abstand passt sich der Länge an (300 m … 2 km). */
export function candidates(ev: RaceEvent): Candidate[] {
  const total = ev.legs.reduce((s, l) => s + legDistance(l), 0);
  const spacing = Math.min(2000, Math.max(300, total / 60));
  const out: Candidate[] = [];
  let offset = 0;
  ev.legs.forEach((leg, legIndex) => {
    const len = legDistance(leg);
    const add = (alongLeg: number) => {
      const along = offset + alongLeg;
      out.push({ id: `km${Math.round(along / 100)}`, along, legIndex, point: pointAtDistance(leg.points, alongLeg) });
    };
    if (leg.discipline === 'schwimmen') {
      // Im Wasser kann niemand stehen: nur Schwimmstart und -ausstieg
      add(0);
      add(len);
    } else {
      for (let d = 0; d <= len; d += spacing) add(d);
      if (len % spacing > spacing / 3) add(len);
    }
    offset += len;
  });
  // Doppelte (gleiche Kennung, z. B. Etappengrenzen) entfernen
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

export type TravelFn = (from: Point, to: Point) => number; // Sekunden

export function estimateTravel(speedKmh: number, detour = DETOUR): TravelFn {
  const v = speedKmh / 3.6;
  return (a, b) => (haversine(a, b) * detour) / v;
}

export interface Stop {
  candidate: Candidate;
  /** Ankunftszeit (ms) */
  arrive: number;
  /** Durchgang des Plan-Athleten (ms) */
  pass: number;
  /** Abfahrt zum nächsten Stopp (ms) */
  depart: number;
  /** Wegzeit hierher (s) */
  travel: number;
}

export interface PlanInput {
  candidates: Candidate[];
  timeline: Timeline;
  start: Point;
  /** Frühester Aufbruch (ms) */
  startTime: number;
  maxStops: number;
  travel: TravelFn;
  /** Mindestabstand zwischen zwei Stopps entlang der Strecke (m) */
  minGap?: number;
}

interface Beam {
  stops: Stop[];
  pos: Point;
  time: number;
  lastAlong: number;
  travelSum: number;
}

/** Plant bis zu maxStops Stopps für einen Athleten. Bevorzugt mehr Stopps, dann weniger Weg. */
export function planStops(input: PlanInput): Stop[] {
  const { candidates: cands, timeline: tl, start, startTime, maxStops, travel } = input;
  const minGap = input.minGap ?? 1500;
  const pass = new Map(cands.map((c) => [c.id, timeAtAlong(tl, c.along)]));
  const WIDTH = 40;

  let beams: Beam[] = [{ stops: [], pos: start, time: startTime, lastAlong: -Infinity, travelSum: 0 }];
  let best: Beam = beams[0];

  for (let depth = 0; depth < maxStops; depth++) {
    const next: Beam[] = [];
    for (const b of beams) {
      for (const c of cands) {
        if (c.along < b.lastAlong + minGap) continue;
        const p = pass.get(c.id)!;
        const t = travel(b.pos, c.point);
        const arrive = b.time + t * 1000;
        if (arrive + ARRIVAL_BUFFER_MS > p) continue;
        const stop: Stop = { candidate: c, arrive, pass: p, depart: p + LINGER_MS, travel: t };
        next.push({
          stops: [...b.stops, stop],
          pos: c.point,
          time: stop.depart,
          lastAlong: c.along,
          travelSum: b.travelSum + t,
        });
      }
    }
    if (next.length === 0) break;
    // Bei gleicher Stoppzahl: früher wieder frei (mehr Chancen danach) und weniger Weg
    next.sort((x, y) => x.time - y.time || x.travelSum - y.travelSum);
    // Vielfalt: pro letztem Kandidaten nur die beste Abfolge behalten
    const byLast = new Map<string, Beam>();
    for (const n of next) {
      const key = n.stops[n.stops.length - 1].candidate.id;
      if (!byLast.has(key)) byLast.set(key, n);
    }
    beams = [...byLast.values()].slice(0, WIDTH);
    // Unter den Abfolgen dieser Länge die mit dem wenigsten Weg als Kandidat fürs Ergebnis
    best = [...byLast.values()].sort((x, y) => x.travelSum - y.travelSum)[0];
  }
  return best.stops;
}

/** Durchgangszeiten aller Athleten an einer Stelle. */
export function passTimes(ev: RaceEvent, athletes: Athlete[], along: number, today: Date): number[] {
  return athletes.map((a) => timeAtAlong(timeline(ev, a, today), along));
}

// ---------------------------------------------------------------- Sperrlinien fürs Routing

/**
 * Die Strecke als Sperrlinien (BRouter „polylines“), damit Wege sie nicht queren.
 * Rund um Start- und Zielpunkt des Weges bleibt ein Fenster offen (dort will man ja hin).
 * Schwimm-Etappen sperren nichts.
 */
export function nogoLines(
  ev: RaceEvent,
  keepOpen: Point[],
  radius = 200,
  tolerance = 40,
  corridor?: { from: Point; to: Point },
): Point[][] {
  // Nur Streckenteile im Umkreis des Weges sperren – weiter weg kommt der Weg ohnehin nicht hin
  // (hält die Anfrage auch bei langen Strecken kurz).
  let inCorridor = (_p: Point) => true;
  if (corridor) {
    const { from, to } = corridor;
    const margin = Math.max(2000, haversine(from, to) * 0.6);
    const dLat = margin / 111_195;
    const dLng = margin / (111_195 * Math.cos(((from.lat + to.lat) / 2) * (Math.PI / 180)));
    const minLat = Math.min(from.lat, to.lat) - dLat;
    const maxLat = Math.max(from.lat, to.lat) + dLat;
    const minLng = Math.min(from.lng, to.lng) - dLng;
    const maxLng = Math.max(from.lng, to.lng) + dLng;
    inCorridor = (p) => p.lat >= minLat && p.lat <= maxLat && p.lng >= minLng && p.lng <= maxLng;
  }
  const lines: Point[][] = [];
  for (const leg of ev.legs) {
    if (leg.discipline === 'schwimmen') continue;
    let run: Point[] = [];
    for (const p of densify(simplify(leg.points, tolerance), radius / 2)) {
      if (!inCorridor(p) || keepOpen.some((k) => haversine(k, p) < radius)) {
        if (run.length >= 2) lines.push(run);
        run = [];
      } else run.push(p);
    }
    if (run.length >= 2) lines.push(run);
  }
  return lines;
}

/** Lange Abschnitte unterteilen, damit das Fenster um einen Punkt nicht von einer langen Geraden überbrückt wird. */
function densify(points: Point[], maxStep: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push(a);
    const b = points[i + 1];
    if (!b) break;
    const n = Math.floor(haversine(a, b) / maxStep);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) });
    }
  }
  return out;
}
