import { nearestOnPath, pathLength, type Nearest } from './geo';
import type { Leg, Point, RaceEvent } from './model';

export interface CourseStats {
  distance: number;
  elevationGain: number | null;
}

export function legDistance(leg: Leg): number {
  return pathLength(leg.points);
}

export function courseStats(ev: RaceEvent): CourseStats {
  let distance = 0;
  let gain = 0;
  let hasGain = false;
  for (const leg of ev.legs) {
    distance += legDistance(leg);
    if (leg.elevationGain != null) {
      gain += leg.elevationGain;
      hasGain = true;
    }
  }
  return { distance, elevationGain: hasGain ? gain : null };
}

export interface CourseNearest extends Nearest {
  legIndex: number;
  /** Position entlang der Etappe in m */
  alongLeg: number;
}

/** Nächster Streckenpunkt über alle Etappen; `along` zählt ab Start der ersten Etappe. */
export function nearestOnCourse(ev: RaceEvent, p: Point): CourseNearest | null {
  let best: CourseNearest | null = null;
  let offset = 0;
  ev.legs.forEach((leg, legIndex) => {
    const n = nearestOnPath(leg.points, p);
    if (n && (!best || n.distance < best.distance)) {
      best = { ...n, along: offset + n.along, alongLeg: n.along, legIndex };
    }
    offset += legDistance(leg);
  });
  return best;
}
