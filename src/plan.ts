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

  // Echte Wegzeiten je Wegstück merken: Nachplanen nutzt sie direkt, statt einen einzelnen
  // Ausreißer als Umwegfaktor auf alle Wege hochzurechnen.
  const key = (a: Point, b: Point) => `${a.lat},${a.lng}>${b.lat},${b.lng}`;
  const realTravel = new Map<string, number>();
  const ratios: number[] = [];
  let detour = DETOUR;
  let best: PlannedStop[] = [];
  const score = (r: PlannedStop[]) => r.filter((s) => !s.tight).length * 10 + r.length;

  for (let round = 0; round < 4; round++) {
    const estimate = estimateTravel(settings.speed, detour);
    const travel = (a: Point, b: Point) => realTravel.get(key(a, b)) ?? estimate(a, b);
    const stops = planStops({ candidates: cands, timeline: tl, start, startTime, maxStops: settings.maxStops, travel });
    const result: PlannedStop[] = [];
    let pos = start;
    let time = startTime;
    for (const s of stops) {
      const route = await getRoute(pos, s.candidate.point);
      const t = route.distance / v;
      if (route.routed && !realTravel.has(key(pos, s.candidate.point))) {
        realTravel.set(key(pos, s.candidate.point), t);
        const straight = estimateTravel(settings.speed, 1)(pos, s.candidate.point);
        if (straight > 0) ratios.push(t / straight);
      }
      const arrive = time + t * 1000;
      result.push({ ...s, travel: t, arrive, depart: s.pass + LINGER_MS, route, tight: arrive + ARRIVAL_BUFFER_MS > s.pass });
      pos = s.candidate.point;
      time = Math.max(arrive, s.pass) + LINGER_MS;
    }
    if (score(result) > score(best)) best = result;
    if (!result.some((s) => s.tight)) break;
    // Umwegfaktor für noch ungeprüfte Wege: typischer Wert (Median) – erst ab 3 echten Wegen
    // und gedeckelt, damit einzelne Ausreißer (z. B. „Insel“-Umwege) nicht alles unerreichbar machen.
    // Die bekannten Wege selbst stecken schon exakt in realTravel.
    const sorted = [...ratios].sort((a, b) => a - b);
    if (sorted.length >= 3) detour = Math.min(2.2, Math.max(DETOUR, sorted[Math.floor(sorted.length / 2)]));
  }
  // Ab dem ersten knappen Stopp ist der Rest des Plans nicht verlässlich → abschneiden,
  // sofern davor schon mindestens ein sicherer Stopp liegt.
  const firstTight = best.findIndex((s) => s.tight);
  const result = firstTight > 0 ? best.slice(0, firstTight) : best;
  return { settings, start, startTime, stops: result, estimated: result.some((s) => !s.route.routed) };
}

export function modeLabel(mode: Mode): string {
  return MODES[mode].label;
}
