import { legDistance } from './course';
import { pointAtDistance } from './geo';
import type { Athlete, Discipline, Point, RaceEvent } from './model';

/*
 * Zeitplan eines Athleten „laut Plan“: aus Startzeit, Pace je Disziplin und
 * Wechselzeiten wird berechnet, wann er wo ist.
 *
 * Wechsel: Gibt es eine eigene Wechsel-Etappe, dauert sie `transition`.
 * Folgen zwei Etappen unterschiedlicher Disziplin direkt aufeinander (z. B. Swim → Bike),
 * wird dazwischen ebenfalls `transition` eingeplant; der Athlet steht dann am Etappenende.
 */

/** Geschwindigkeit in m/s; null bei Wechsel-Etappen (die haben eine feste Dauer). */
export function speed(athlete: Athlete, discipline: Discipline): number | null {
  switch (discipline) {
    case 'schwimmen':
      return 100 / athlete.pace.schwimmen;
    case 'rad':
      return athlete.pace.rad / 3.6;
    case 'lauf':
      return 1000 / athlete.pace.lauf;
    case 'wechsel':
      return null;
  }
}

export type Segment =
  | { kind: 'leg'; legIndex: number; t0: number; t1: number; offset: number; length: number }
  | { kind: 'wechsel'; afterLeg: number; t0: number; t1: number };

export interface Timeline {
  start: number;
  finish: number;
  segments: Segment[];
}

/** Startzeitpunkt (ms) aus Renntag und "HH:MM" in Ortszeit des Geräts. */
export function startTime(ev: RaceEvent, athlete: Athlete, today: Date): number {
  const [h, m] = athlete.start.split(':').map(Number);
  const base = ev.date ? new Date(`${ev.date}T00:00:00`) : new Date(today);
  base.setHours(h, m, 0, 0);
  return base.getTime();
}

export function timeline(ev: RaceEvent, athlete: Athlete, today: Date): Timeline {
  const start = startTime(ev, athlete, today);
  const segments: Segment[] = [];
  let t = start;
  let offset = 0;
  ev.legs.forEach((leg, i) => {
    const prev = ev.legs[i - 1];
    if (prev && prev.discipline !== leg.discipline && prev.discipline !== 'wechsel' && leg.discipline !== 'wechsel') {
      segments.push({ kind: 'wechsel', afterLeg: i - 1, t0: t, t1: t + athlete.transition * 1000 });
      t += athlete.transition * 1000;
    }
    const length = legDistance(leg);
    const v = speed(athlete, leg.discipline);
    const duration = v ? (length / v) * 1000 : athlete.transition * 1000;
    segments.push({ kind: 'leg', legIndex: i, t0: t, t1: t + duration, offset, length });
    t += duration;
    offset += length;
  });
  return { start, finish: t, segments };
}

export type PlanState =
  | { state: 'vor-start'; start: number }
  | { state: 'im-ziel'; finish: number }
  | { state: 'unterwegs'; legIndex: number; along: number; alongLeg: number; point: Point; inTransition: boolean };

/** Wo ist der Athlet laut Plan zum Zeitpunkt `now`? */
export function planAt(ev: RaceEvent, tl: Timeline, now: number): PlanState {
  if (now < tl.start) return { state: 'vor-start', start: tl.start };
  if (now >= tl.finish) return { state: 'im-ziel', finish: tl.finish };
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i];
    if (now < s.t0 || now >= s.t1) continue;
    if (s.kind === 'wechsel') {
      const leg = ev.legs[s.afterLeg];
      const prev = tl.segments.find((x) => x.kind === 'leg' && x.legIndex === s.afterLeg) as Extract<Segment, { kind: 'leg' }>;
      return {
        state: 'unterwegs',
        legIndex: s.afterLeg,
        along: prev.offset + prev.length,
        alongLeg: prev.length,
        point: leg.points[leg.points.length - 1],
        inTransition: true,
      };
    }
    const leg = ev.legs[s.legIndex];
    const frac = s.t1 === s.t0 ? 1 : (now - s.t0) / (s.t1 - s.t0);
    const alongLeg = frac * s.length;
    return {
      state: 'unterwegs',
      legIndex: s.legIndex,
      along: s.offset + alongLeg,
      alongLeg,
      point: pointAtDistance(leg.points, alongLeg),
      inTransition: leg.discipline === 'wechsel',
    };
  }
  return { state: 'im-ziel', finish: tl.finish };
}

/** Wann passiert der Athlet laut Plan die Stelle `along` (m ab Start)? */
export function timeAtAlong(tl: Timeline, along: number): number {
  const legs = tl.segments.filter((s): s is Extract<Segment, { kind: 'leg' }> => s.kind === 'leg');
  for (const s of legs) {
    if (along <= s.offset + s.length) {
      const frac = s.length === 0 ? 0 : Math.max(0, along - s.offset) / s.length;
      return s.t0 + frac * (s.t1 - s.t0);
    }
  }
  return tl.finish;
}
