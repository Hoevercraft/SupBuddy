import { BackendError, createTracker, deleteTracker, fetchLive, isExpiredError, trackUrl } from './backend';
import { legDistance } from './course';
import { haversine, project } from './geo';
import type { Athlete, Discipline, Leg, RaceEvent } from './model';
import { buildTimeline, speed, timeAtAlong, timeline, type Correction } from './schedule';
import { latestByAthlete, type Sighting } from './sightings';

/*
 * Stufe 6: Live-Standort des Athleten.
 *
 * Der Athlet sendet mit der kostenlosen App „Traccar Client“ jede Minute seine Position direkt an
 * die Datenbank (Funktion `track`, Token im Einrichtungslink). SupBuddy holt die Positionen im
 * selben Takt wie die Sichtungen, rastet sie auf die Strecke ein und rechnet damit:
 *  - Position = letzte Live-Position (Anker), danach geht es mit der gemessenen Pace weiter.
 *  - Gemessene Pace = Schnitt der laufenden Disziplin seit ihrem Beginn (nicht das Tempo der
 *    letzten Minuten – das verfälscht z. B. bei Abfahrten). Am Anfang mit der geschätzten Pace
 *    gemischt, bis 2 km gemessen sind. Kommende Disziplinen behalten die geschätzte Pace.
 *  - Noch am Start (keine 200 m auf der Strecke): vor der geplanten Startzeit gilt der Plan;
 *    danach „wartet am Start“ – der Plan beginnt erst, wenn er wirklich losfährt (Wellenstart,
 *    Verschiebung). Ohne frische Meldung ab der letzten Meldung am Start.
 *  - Kommt länger nichts (Funkloch, Akku), rechnet die Prognose ab der letzten Position weiter;
 *    eine neuere Sichtung wird dann wieder als Anker genommen.
 */

/** Ab so langer Stille gilt das Tracking als „still“ (Sichtung wird wieder angeboten). */
export const LIVE_STALE_MS = 5 * 60_000;
/** Weiter weg von der Strecke zählt eine Position nicht (z. B. vor dem Start zu Hause). */
export const LIVE_SNAP_M = 300;
/** Erst ab so viel Strecke gilt der Athlet als gestartet. */
export const LIVE_MOVED_M = 200;
/** Bis so viel gemessen ist, wird mit der geschätzten Pace gemischt. */
const BLEND_M = 2000;

export interface LivePoint {
  /** ms */
  at: number;
  lat: number;
  lng: number;
  /** Genauigkeit in m */
  acc: number | null;
}

export interface SnappedPoint {
  at: number;
  /** m ab Start */
  along: number;
}

export interface LiveFix {
  /** Anker: letzte Position auf der Strecke */
  along: number;
  at: number;
  discipline: Discipline;
  /** gemessene Geschwindigkeit der laufenden Disziplin (m/s), null = noch zu wenig gemessen */
  measured: number | null;
  /** für die Prognose (gemischt mit der Schätzung) */
  speeds: Partial<Record<Discipline, number>>;
  /** steht noch am Start (keine 200 m gefahren) */
  waiting: boolean;
}

// ---------------------------------------------------------------- Logik

type Cand = { along: number; distance: number }[];
const candCache = new WeakMap<Leg[], Map<string, Cand>>();

/** Stellen der Strecke nahe einer Position (zwischengespeichert, je Strecke). */
function candidates(ev: RaceEvent, p: LivePoint): Cand {
  let m = candCache.get(ev.legs);
  if (!m) candCache.set(ev.legs, (m = new Map()));
  const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  let c = m.get(key);
  if (!c) m.set(key, (c = projectedNear(ev, p, LIVE_SNAP_M)));
  return c;
}

/**
 * Wie alongsNear, aber genau: auf die Streckenabschnitte projiziert (die Strecke ist vereinfacht,
 * ihre Punkte liegen teils Hunderte Meter auseinander). Je zusammenhängendem Stück die nächste Stelle.
 */
function projectedNear(ev: RaceEvent, p: LivePoint, radius: number): Cand {
  const me = { lat: p.lat, lng: p.lng };
  const out: Cand = [];
  let offset = 0;
  for (const leg of ev.legs) {
    const pts = leg.points;
    let run: { along: number; distance: number } | null = null;
    let cum = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = haversine(pts[i - 1], pts[i]);
      const a = project(pts[i - 1], me);
      const b = project(pts[i], me);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / len2));
      const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
      if (d <= radius) {
        if (!run || d < run.distance) run = { along: offset + cum + t * seg, distance: d };
      } else if (run) {
        out.push(run);
        run = null;
      }
      cum += seg;
    }
    if (run) out.push(run);
    offset += legDistance(leg);
  }
  return out;
}

/** Disziplin an einer Stelle und wo deren zusammenhängender Abschnitt beginnt. */
export function disciplineAt(ev: RaceEvent, along: number): { discipline: Discipline; runStart: number } {
  let offset = 0;
  let runStart = 0;
  for (let i = 0; i < ev.legs.length; i++) {
    const leg = ev.legs[i];
    if (i === 0 || leg.discipline !== ev.legs[i - 1].discipline) runStart = offset;
    const len = legDistance(leg);
    if (along <= offset + len || i === ev.legs.length - 1) return { discipline: leg.discipline, runStart };
    offset += len;
  }
  return { discipline: 'rad', runStart: 0 };
}

const planSpeed = (athlete: Athlete, d: Discipline) => (d === 'wechsel' ? 0 : (speed(athlete, d) ?? 0));

/**
 * Positionen auf die Strecke einrasten, zeitlich fortschreitend: Bei Rundkursen und Wendepunkten
 * gewinnt die Stelle, die zum bisherigen Verlauf passt (die erste: die zeitlich zum Plan passt).
 * Positionen abseits der Strecke werden übergangen.
 */
export function snapTrack(ev: RaceEvent, athlete: Athlete, points: LivePoint[], today: Date): SnappedPoint[] {
  const tl = timeline(ev, athlete, today, true);
  const out: SnappedPoint[] = [];
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    const c = candidates(ev, p);
    if (!c.length) continue;
    const prev = out[out.length - 1];
    const score = prev
      ? (x: { along: number }) => {
          const v = planSpeed(athlete, disciplineAt(ev, prev.along).discipline);
          const expected = prev.along + (v * Math.max(0, p.at - prev.at)) / 1000;
          return Math.abs(x.along - expected);
        }
      : (x: { along: number }) => Math.abs(timeAtAlong(tl, x.along) - p.at);
    const best = c.reduce((a, b) => (score(b) < score(a) ? b : a));
    out.push({ at: p.at, along: best.along });
  }
  return out;
}

/** Anker und gemessene Pace aus den eingerasteten Positionen; null = keine Position an der Strecke. */
export function liveFix(ev: RaceEvent, athlete: Athlete, snapped: SnappedPoint[]): LiveFix | null {
  const last = snapped[snapped.length - 1];
  if (!last) return null;
  const { discipline, runStart } = disciplineAt(ev, last.along);
  if (last.along < LIVE_MOVED_M) return { along: last.along, at: last.at, discipline, measured: null, speeds: {}, waiting: true };
  // Bezug: letzter Zeitpunkt, an dem er noch am Anfang der Disziplin war – sonst der erste Punkt darin
  const atStart = snapped.filter((s) => s.along <= runStart + 100 && s.at <= last.at);
  const ref = atStart[atStart.length - 1] ?? snapped.find((s) => s.along >= runStart);
  const planned = planSpeed(athlete, discipline);
  let measured: number | null = null;
  if (ref && discipline !== 'wechsel') {
    const dAlong = last.along - ref.along;
    const dt = (last.at - ref.at) / 1000;
    if (dAlong >= 100 && dt >= 60) measured = Math.min(planned * 3, Math.max(planned * 0.3, dAlong / dt));
  }
  const speeds: Partial<Record<Discipline, number>> = {};
  if (measured !== null && ref) {
    const w = Math.min(1, (last.along - ref.along) / BLEND_M);
    speeds[discipline] = w * measured + (1 - w) * planned;
  }
  return { along: last.along, at: last.at, discipline, measured, speeds, waiting: false };
}

/**
 * Korrekturen je Athlet aus Sichtungen und Live-Tracking. Anker ist die jüngste Information
 * (Live-Position oder Sichtung); die gemessene Pace gilt in beiden Fällen.
 */
export function correctionsFrom(ev: RaceEvent, sightings: Sighting[], fixes: Map<string, LiveFix>, today: Date, now = today.getTime()): Map<string, Correction> {
  const latest = latestByAthlete(sightings);
  const out = new Map<string, Correction>();
  for (const a of ev.athletes) {
    if (!a.id) continue;
    const fix = fixes.get(a.id);
    const s = latest.get(a.id);
    if (fix?.waiting && (!s || s.seenAt <= fix.at)) {
      // Steht am Start: Start frühestens jetzt (bzw. bei der letzten Meldung, wenn keine mehr kommt)
      const hold = now - fix.at < LIVE_STALE_MS ? now : fix.at;
      const offset = hold - timeAtAlong(buildTimeline(ev, a, today, null), fix.along);
      if (offset > 0) out.set(a.id, { offset });
      continue;
    }
    const anchor = fix && (!s || s.seenAt <= fix.at) ? { along: fix.along, at: fix.at } : s ? { along: s.along, at: s.seenAt } : null;
    if (!anchor) continue;
    const speeds = fix && Object.keys(fix.speeds).length ? fix.speeds : undefined;
    const planned = timeAtAlong(buildTimeline(ev, a, today, { offset: 0, speeds }), anchor.along);
    out.set(a.id, { offset: anchor.at - planned, ...(speeds ? { speeds } : {}) });
  }
  return out;
}

/** Einrichtungslink für Traccar Client: Server, Token, jede Minute, auch im Stand, mit Puffer. */
export function traccarLink(token: string): string {
  const q = new URLSearchParams({
    url: trackUrl(),
    id: token,
    accuracy: 'highest',
    interval: '60',
    distance: '0',
    stop_detection: 'false',
    buffer: 'true',
  });
  return `org.traccar.client://config?${q}`;
}

// ---------------------------------------------------------------- Speicher + Abgleich

export type LiveState = 'idle' | 'ok' | 'offline' | 'expired';

export interface LiveView {
  /** Tracking ist eingerichtet */
  tracking: boolean;
  /** letzte empfangene Position (ms), auch abseits der Strecke */
  lastAt: number | null;
  /** letzte Position liegt an der Strecke */
  onCourse: boolean;
  fix: LiveFix | null;
  /** Live-Daten frisch (an der Strecke) */
  fresh: boolean;
  /** frisch und unterwegs → Sichtung und Pace-Eingabe entfallen */
  active: boolean;
}

/** Live-Positionen eines Events (nur im Speicher; beim Öffnen neu geholt). */
export class LiveStore {
  trackers = new Set<string>();
  points = new Map<string, LivePoint[]>();
  state: LiveState = 'idle';
  private eventId: string | null = null;
  private since: string | null = null;
  private busy: Promise<void> | null = null;
  /** Ergebnisse je Athlet, bis neue Positionen kommen */
  private snapCache = new Map<string, { n: number; legs: Leg[]; snapped: SnappedPoint[] }>();

  constructor(private onChange: () => void) {}

  /** Event, dessen Live-Stand geholt wird (null = keins, z. B. noch nicht geteilt). */
  setEvent(eventId: string | null): void {
    if (eventId === this.eventId) return;
    this.eventId = eventId;
    this.trackers = new Set();
    this.points = new Map();
    this.snapCache.clear();
    this.since = null;
    this.state = 'idle';
    this.onChange();
    if (eventId) void this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.eventId || this.state === 'expired') return Promise.resolve();
    if (!this.busy) this.busy = this.doRefresh().finally(() => (this.busy = null));
    return this.busy;
  }

  private async doRefresh(): Promise<void> {
    const ev = this.eventId;
    if (!ev) return;
    try {
      const r = await fetchLive(ev, this.since);
      if (this.eventId !== ev) return;
      let changed = this.state !== 'ok';
      const trackers = new Set(r.trackers);
      if (trackers.size !== this.trackers.size || [...trackers].some((t) => !this.trackers.has(t))) changed = true;
      this.trackers = trackers;
      for (const id of [...this.points.keys()]) if (!trackers.has(id)) this.points.delete(id);
      for (const p of r.positions) {
        if (!trackers.has(p.a)) continue;
        const list = this.points.get(p.a) ?? [];
        const at = Date.parse(p.t);
        if (!Number.isFinite(at) || list.some((x) => x.at === at)) continue;
        list.push({ at, lat: p.lat, lng: p.lon, acc: p.acc });
        list.sort((a, b) => a.at - b.at);
        this.points.set(p.a, list);
        changed = true;
      }
      // Etwas Überlappung: was kurz vor der Serverzeit ankam, nicht verpassen (Doppelte fallen raus)
      this.since = new Date(Date.parse(r.now) - 60_000).toISOString();
      this.state = 'ok';
      if (changed) this.onChange();
    } catch (e) {
      const next: LiveState = isExpiredError(e) ? 'expired' : 'offline';
      if (next !== this.state) {
        this.state = next;
        this.onChange();
      }
    }
  }

  /** Tracking einrichten → Token für den Einrichtungslink. */
  async create(athleteId: string): Promise<string> {
    if (!this.eventId) throw new BackendError('Event nicht geteilt', 400);
    const token = await createTracker(this.eventId, athleteId);
    this.trackers.add(athleteId);
    this.onChange();
    return token;
  }

  /** Tracking beenden (Positionen werden auch auf dem Server gelöscht). */
  async remove(athleteId: string): Promise<void> {
    if (!this.eventId) return;
    await deleteTracker(this.eventId, athleteId);
    this.trackers.delete(athleteId);
    this.points.delete(athleteId);
    this.snapCache.delete(athleteId);
    this.onChange();
  }

  /** Eingerastete Positionen (nur neu berechnet, wenn neue Punkte da sind). */
  snapped(ev: RaceEvent, athlete: Athlete, today: Date): SnappedPoint[] {
    const pts = athlete.id ? this.points.get(athlete.id) : undefined;
    if (!athlete.id || !pts?.length) return [];
    const c = this.snapCache.get(athlete.id);
    if (c && c.n === pts.length && c.legs === ev.legs) return c.snapped;
    const snapped = snapTrack(ev, athlete, pts, today);
    this.snapCache.set(athlete.id, { n: pts.length, legs: ev.legs, snapped });
    return snapped;
  }

  fixes(ev: RaceEvent, today: Date): Map<string, LiveFix> {
    const out = new Map<string, LiveFix>();
    for (const a of ev.athletes) {
      if (!a.id || !this.trackers.has(a.id)) continue;
      const fix = liveFix(ev, a, this.snapped(ev, a, today));
      if (fix) out.set(a.id, fix);
    }
    return out;
  }

  view(ev: RaceEvent, athlete: Athlete, now: number): LiveView {
    const id = athlete.id;
    const tracking = !!id && this.trackers.has(id);
    const pts = id ? this.points.get(id) : undefined;
    const last = pts?.[pts.length - 1];
    const snapped = tracking ? this.snapped(ev, athlete, new Date(now)) : [];
    const fix = tracking ? liveFix(ev, athlete, snapped) : null;
    return {
      tracking,
      lastAt: last?.at ?? null,
      onCourse: !!last && snapped[snapped.length - 1]?.at === last.at,
      fix,
      fresh: !!fix && now - fix.at < LIVE_STALE_MS,
      active: !!fix && !fix.waiting && now - fix.at < LIVE_STALE_MS,
    };
  }
}
