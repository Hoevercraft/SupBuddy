import { ARRIVAL_BUFFER_MS, candidates, DETOUR, estimateTravel, LINGER_MS, MODES, planStops, type Candidate, type Mode, type Stop } from './cheer';
import { haversine, pathLength } from './geo';
import { chooseJourney, estimateTransitSeconds, type Journey } from './transit';
import type { Point, RaceEvent } from './model';
import { estimatedRoute, type Route } from './routing';
import { timeline } from './schedule';

/** So lange vor dem Start des Athleten geht's los, wenn noch vor dem Rennen geplant wird. */
export const PRE_START_MS = 30 * 60_000;

export interface PlanSettings {
  athleteIndex: number;
  mode: Mode;
  /** km/h (bei Bus & Bahn: Gehtempo) */
  speed: number;
  maxStops: number;
  /** Anzahl Supporter (für den Ticket-Tipp) */
  people?: number;
}

export interface PlannedStop extends Stop {
  route: Route;
  /** Ankunft liegt nach (Durchgang − Puffer): wird knapp */
  tight: boolean;
  /** Bus-&-Bahn-Verbindung (sonst Fußweg/Rad) */
  journey?: Journey;
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
/** Verbindungen mit Bus & Bahn: Abfahrt ab `time` bzw. (arriveBy) Ankunft bis `time`; null = Dienst nicht erreichbar */
export type JourneyFetcher = (from: Point, to: Point, time: number, arriveBy: boolean) => Promise<Journey[] | null>;

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
  fetchJourneys?: JourneyFetcher,
): Promise<Plan> {
  if (settings.mode === 'oepnv' && fetchJourneys) return buildTransitPlan(ev, settings, start, now, fetchRoute, fetchJourneys);
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

const pkey = (a: Point, b: Point) => `${a.lat},${a.lng}>${b.lat},${b.lng}`;

/** Weg aus einer Verbindung (Fußwege + Fahrten) für die Karte. */
export function journeyRoute(j: Journey, from: Point, to: Point): Route {
  const points = j.legs.flatMap((l) => l.points);
  const pts = points.length >= 2 ? points : [from, to];
  return { points: pts, distance: pathLength(pts), routed: true };
}

/**
 * Plan mit Bus & Bahn: Stopps wie gewohnt (Beam-Suche mit geschätzten Zeiten), dann je Stopp
 * die echte Verbindung, die vor dem Athleten ankommt. Ist zu Fuß schneller, wird gelaufen.
 * Ist der Fahrplan nicht erreichbar, bleibt es bei der Schätzung (Hinweis in der Oberfläche).
 */
async function buildTransitPlan(
  ev: RaceEvent,
  settings: PlanSettings,
  start: Point,
  now: number,
  fetchRoute: RouteFetcher,
  fetchJourneys: JourneyFetcher,
): Promise<Plan> {
  const athlete = ev.athletes[settings.athleteIndex];
  const tl = timeline(ev, athlete, new Date(now));
  const startTime = Math.max(now, tl.start - PRE_START_MS);
  const cands = candidates(ev);
  const walkV = settings.speed / 3.6;

  const walkCache = new Map<string, Route>();
  const walk = async (a: Point, b: Point): Promise<Route> => {
    const k = pkey(a, b);
    let r = walkCache.get(k);
    if (!r) {
      r = (await fetchRoute(a, b)) ?? estimatedRoute(a, b, DETOUR);
      walkCache.set(k, r);
    }
    return r;
  };
  const jCache = new Map<string, Journey[] | null>();
  const journeys = async (a: Point, b: Point, time: number, arriveBy: boolean) => {
    const k = `${pkey(a, b)}|${arriveBy}|${Math.round(time / 60_000)}`;
    if (!jCache.has(k)) jCache.set(k, await fetchJourneys(a, b, time, arriveBy));
    return jCache.get(k)!;
  };

  /** Bester Weg zu einem Stopp ab `earliest` (Fuß oder Bus & Bahn). */
  const leg = async (from: Point, c: Candidate, earliest: number, pass: number) => {
    const deadline = pass - ARRIVAL_BUFFER_MS;
    const options: { start: number; end: number; route: Route; journey?: Journey }[] = [];
    const straight = haversine(from, c.point);
    // Zu Fuß (bis ca. 45 min Gehzeit)
    if ((straight * DETOUR) / walkV <= 45 * 60) {
      const r = await walk(from, c.point);
      options.push({ start: earliest, end: earliest + (r.distance / walkV) * 1000, route: r });
    }
    let unavailable = false;
    if (straight > 600) {
      let found = await journeys(from, c.point, deadline, true);
      let choice = found ? chooseJourney(found, earliest, deadline) : null;
      if (found && !choice?.inTime) {
        // Keine passende Verbindung bis zum Durchgang → früheste Ankunft (wird knapp)
        found = await journeys(from, c.point, earliest, false);
        choice = found ? chooseJourney(found, earliest, Infinity) : null;
      }
      if (found === null) unavailable = true;
      if (choice) options.push({ start: choice.journey.start, end: choice.journey.end, route: journeyRoute(choice.journey, from, c.point), journey: choice.journey });
    }
    const inTime = options.filter((o) => o.end <= deadline);
    if (inTime.length) return inTime.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (unavailable) {
      // Fahrplan nicht erreichbar: geschätzte Bus-&-Bahn-Zeit
      const t = estimateTransitSeconds(from, c.point, settings.speed);
      return { start: earliest, end: earliest + t * 1000, route: estimatedRoute(from, c.point, DETOUR) };
    }
    if (options.length) return options.sort((a, b) => a.end - b.end)[0];
    const t = estimateTransitSeconds(from, c.point, settings.speed);
    return { start: earliest, end: earliest + t * 1000, route: estimatedRoute(from, c.point, DETOUR) };
  };

  const realTravel = new Map<string, number>();
  let best: PlannedStop[] = [];
  const score = (r: PlannedStop[]) => r.filter((s) => !s.tight).length * 10 + r.length;
  const estimate = (a: Point, b: Point) => estimateTransitSeconds(a, b, settings.speed);

  for (let round = 0; round < 3; round++) {
    const travel = (a: Point, b: Point) => realTravel.get(pkey(a, b)) ?? estimate(a, b);
    const stops = planStops({ candidates: cands, timeline: tl, start, startTime, maxStops: settings.maxStops, travel });
    const result: PlannedStop[] = [];
    let pos = start;
    let time = startTime;
    for (const s of stops) {
      const o = await leg(pos, s.candidate, time, s.pass);
      // Für das Nachplanen: Reisezeit plus etwas Wartezeit auf den Anschluss
      realTravel.set(pkey(pos, s.candidate.point), (o.end - o.start) / 1000 + (o.journey ? 300 : 0));
      result.push({
        ...s,
        travel: (o.end - o.start) / 1000,
        arrive: o.end,
        depart: s.pass + LINGER_MS,
        route: o.route,
        journey: o.journey,
        tight: o.end + ARRIVAL_BUFFER_MS > s.pass,
      });
      pos = s.candidate.point;
      time = Math.max(o.end, s.pass) + LINGER_MS;
    }
    if (score(result) > score(best)) best = result;
    if (!result.some((s) => s.tight)) break;
  }
  const firstTight = best.findIndex((s) => s.tight);
  const result = firstTight > 0 ? best.slice(0, firstTight) : best;
  return { settings, start, startTime, stops: result, estimated: result.some((s) => !s.route.routed) };
}

export function modeLabel(mode: Mode): string {
  return MODES[mode].label;
}
