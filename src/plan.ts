import { ARRIVAL_BUFFER_MS, candidates, DETOUR, estimateTravel, LINGER_MS, MODES, planStops, type Mode, type Stop } from './cheer';
import type { Point, RaceEvent } from './model';
import { estimatedRoute, type Route } from './routing';
import { timeline } from './schedule';

/** So lange vor dem Start des Athleten geht's los, wenn noch vor dem Rennen geplant wird. */
export const PRE_START_MS = 30 * 60_000;

export interface PlanSettings {
  athleteIndex: number;
  mode: Mode;
  /** km/h */
  speed: number;
  maxStops: number;
}

export interface PlannedStop extends Stop {
  route: Route;
  /** Ankunft liegt nach (Durchgang − Puffer): wird knapp */
  tight: boolean;
}

export interface Plan {
  settings: PlanSettings;
  start: Point;
  startTime: number;
  stops: PlannedStop[];
  /** Mindestens ein Weg ist nur geschätzt (Routing nicht erreichbar) */
  estimated: boolean;
}

export type RouteFetcher = (from: Point, to: Point) => Promise<Route | null>;

/**
 * Plan erstellen: erst mit geschätzten Wegzeiten planen, dann echte Wege holen und nachrechnen.
 * Sind die echten Wege deutlich länger, wird mit größerem Umwegfaktor neu geplant (max. 3 Runden).
 */
export async function buildPlan(
  ev: RaceEvent,
  settings: PlanSettings,
  start: Point,
  now: number,
  fetchRoute: RouteFetcher,
): Promise<Plan> {
  const athlete = ev.athletes[settings.athleteIndex];
  const tl = timeline(ev, athlete, new Date(now));
  const startTime = Math.max(now, tl.start - PRE_START_MS);
  const cands = candidates(ev);
  const v = settings.speed / 3.6;
  const cache = new Map<string, Route>();

  const getRoute = async (from: Point, to: Point): Promise<Route> => {
    const key = `${from.lat},${from.lng}>${to.lat},${to.lng}`;
    let r = cache.get(key);
    if (!r) {
      r = (await fetchRoute(from, to)) ?? estimatedRoute(from, to, DETOUR);
      cache.set(key, r);
    }
    return r;
  };

  let detour = DETOUR;
  let result: PlannedStop[] = [];
  for (let round = 0; round < 3; round++) {
    const stops = planStops({ candidates: cands, timeline: tl, start, startTime, maxStops: settings.maxStops, travel: estimateTravel(settings.speed, detour) });
    // Mit echten Wegen nachrechnen
    result = [];
    let pos = start;
    let time = startTime;
    let worst = 1;
    for (const s of stops) {
      const route = await getRoute(pos, s.candidate.point);
      const travel = route.distance / v;
      const arrive = time + travel * 1000;
      const tight = arrive + ARRIVAL_BUFFER_MS > s.pass;
      result.push({ ...s, travel, arrive, depart: s.pass + LINGER_MS, route, tight });
      const est = s.travel || 1;
      worst = Math.max(worst, travel / est);
      pos = s.candidate.point;
      time = Math.max(arrive, s.pass) + LINGER_MS;
    }
    if (!result.some((s) => s.tight)) break;
    detour *= worst * 1.05;
  }
  // Bleibt ein Stopp knapp, wird er als „knapp“ angezeigt statt stillschweigend gestrichen
  // (spätere Wege bauen auf ihm auf).
  return { settings, start, startTime, stops: result, estimated: result.some((s) => !s.route.routed) };
}

export function modeLabel(mode: Mode): string {
  return MODES[mode].label;
}
