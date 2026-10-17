import { addSighting, BackendError, deleteSighting, fetchSightings, isExpiredError, type RemoteSighting } from './backend';
import { legDistance } from './course';
import { haversine } from './geo';
import type { Athlete, Point, RaceEvent } from './model';
import { timeAtAlong, timeline } from './schedule';

/*
 * Sichtungen: „Jan jetzt hier“. Eine Sichtung = Athlet + Stelle auf der Strecke + Uhrzeit.
 * Ab der jüngsten Sichtung rechnet der Zeitplan mit der echten Durchgangszeit weiter
 * (der Plan wird um die Abweichung verschoben; die Pace bleibt).
 * Geteilt über Supabase mit allen, die den Link haben; ohne Netz bleibt sie zuerst auf dem
 * Gerät und wird nachgereicht.
 */

export interface Sighting {
  /** Server-Kennung, bei noch nicht hochgeladenen „local-…“ */
  id: string;
  athleteId: string;
  /** m ab Start */
  along: number;
  /** ms */
  seenAt: number;
  /** selbst eingetragen (darf zurückgenommen werden) */
  mine: boolean;
  /** noch nicht beim Server */
  pending?: boolean;
}

/** Höchstens so weit neben der Strecke zählt der eigene Standort als „an der Strecke“. */
export const SIGHT_RADIUS_M = 150;

// ---------------------------------------------------------------- Logik

/** Jüngste Sichtung je Athlet. */
export function latestByAthlete(list: Sighting[]): Map<string, Sighting> {
  const out = new Map<string, Sighting>();
  for (const s of list) {
    const cur = out.get(s.athleteId);
    if (!cur || s.seenAt > cur.seenAt) out.set(s.athleteId, s);
  }
  return out;
}

/** Abweichung je Athlet (ms, + = später als geplant) aus seiner jüngsten Sichtung. */
export function offsetsFrom(ev: RaceEvent, list: Sighting[], today: Date): Map<string, number> {
  const latest = latestByAthlete(list);
  const out = new Map<string, number>();
  for (const a of ev.athletes) {
    const s = a.id ? latest.get(a.id) : undefined;
    if (!s) continue;
    const planned = timeAtAlong(timeline(ev, a, today, true), s.along);
    out.set(a.id!, s.seenAt - planned);
  }
  return out;
}

/**
 * Stellen der Strecke in der Nähe eines Punktes (m ab Start). Bei Rundkursen bzw. Wendepunkten
 * liegt dieselbe Stelle mehrfach auf der Strecke – dann gibt es mehrere Kandidaten.
 */
export function alongsNear(ev: RaceEvent, p: Point, radius = SIGHT_RADIUS_M): { along: number; distance: number }[] {
  const out: { along: number; distance: number }[] = [];
  let offset = 0;
  for (const leg of ev.legs) {
    const pts = leg.points;
    let run: { along: number; distance: number } | null = null;
    let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) cum += haversine(pts[i - 1], pts[i]);
      const d = haversine(pts[i], p);
      if (d <= radius) {
        // innerhalb eines zusammenhängenden Abschnitts nur die nächste Stelle merken
        if (!run || d < run.distance) run = { along: offset + cum, distance: d };
      } else if (run) {
        out.push(run);
        run = null;
      }
    }
    if (run) out.push(run);
    offset += legDistance(leg);
  }
  return out;
}

/**
 * Stelle für „jetzt hier“: von den Kandidaten in der Nähe die, an der der Athlet laut
 * (bisher korrigiertem) Plan zeitlich am ehesten jetzt ist. null = nicht an der Strecke.
 */
export function sightingAlong(ev: RaceEvent, athlete: Athlete, p: Point, now: number): number | null {
  const cands = alongsNear(ev, p);
  if (!cands.length) return null;
  const tl = timeline(ev, athlete, new Date(now));
  cands.sort((a, b) => Math.abs(timeAtAlong(tl, a.along) - now) - Math.abs(timeAtAlong(tl, b.along) - now));
  return cands[0].along;
}

// ---------------------------------------------------------------- Speicher + Abgleich

const KEY = (eventId: string) => `supbuddy:sightings:${eventId}`;

function load(eventId: string): Sighting[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY(eventId)) ?? '[]');
    return Array.isArray(list) ? list.filter((s) => s && typeof s.athleteId === 'string' && Number.isFinite(s.seenAt)) : [];
  } catch {
    return [];
  }
}

function save(eventId: string, list: Sighting[]): void {
  try {
    localStorage.setItem(KEY(eventId), JSON.stringify(list));
  } catch {
    // egal
  }
}

const fromRemote = (r: RemoteSighting): Sighting => ({
  id: r.id,
  athleteId: r.athlete_id,
  along: r.along_m,
  seenAt: Date.parse(r.seen_at),
  mine: !!r.mine,
});

export type SyncState = 'ok' | 'offline' | 'idle' | 'expired';

/** Sichtungen eines Events: lokal gespeichert, mit dem Server abgeglichen. */
export class SightingStore {
  list: Sighting[] = [];
  state: SyncState = 'idle';
  private eventId: string | null = null;
  private busy: Promise<void> | null = null;

  constructor(private onChange: () => void) {}

  /** Anderes Event (oder keins): lokalen Stand laden und abgleichen. */
  setEvent(eventId: string | null): void {
    if (eventId === this.eventId) return;
    this.eventId = eventId;
    this.list = eventId ? load(eventId) : [];
    this.state = 'idle';
    this.onChange();
    if (eventId) void this.refresh();
  }

  /** Mit dem Server abgleichen: Wartende hochladen, dann alle holen. */
  refresh(): Promise<void> {
    if (this.state === 'expired') return Promise.resolve();
    if (!this.busy) {
      this.busy = this.doRefresh().finally(() => (this.busy = null));
    }
    return this.busy;
  }

  private async doRefresh(): Promise<void> {
    const ev = this.eventId;
    if (!ev) return;
    try {
      for (const s of this.list.filter((x) => x.pending)) {
        const r = await addSighting(ev, s.athleteId, s.along, s.seenAt);
        if (this.eventId !== ev) return;
        this.list = this.list.map((x) => (x.id === s.id ? fromRemote(r) : x));
      }
      const remote = (await fetchSightings(ev)).map(fromRemote);
      if (this.eventId !== ev) return;
      const pending = this.list.filter((x) => x.pending);
      this.list = [...remote, ...pending];
      this.state = 'ok';
    } catch (e) {
      if (isExpiredError(e)) {
        // Event abgelaufen: was hier ist, bleibt auf dem Gerät; geteilt wird nichts mehr
        this.list = this.list.map((x) => ({ ...x, pending: false }));
        this.state = 'expired';
        save(ev, this.list);
        this.onChange();
        return;
      }
      // Vom Server als ungültig abgelehnte Sichtung (z. B. älter als 2 Tage) nicht ewig wiederholen.
      // Alle anderen Fehler (offline, Anmeldung gesperrt, Überlast) → behalten und später erneut.
      if (e instanceof BackendError && e.status === 400 && /^Ungültige/.test(e.message)) {
        this.list = this.list.filter((x) => !x.pending);
      }
      this.state = 'offline';
    }
    save(ev, this.list);
    this.onChange();
  }

  /** Neue Sichtung (sofort lokal sichtbar, dann hochladen). */
  async add(athleteId: string, along: number, seenAt: number): Promise<void> {
    if (!this.eventId) return;
    const s: Sighting = { id: `local-${seenAt}-${Math.random().toString(36).slice(2, 8)}`, athleteId, along, seenAt, mine: true, pending: true };
    this.list = [s, ...this.list];
    save(this.eventId, this.list);
    this.onChange();
    await this.refresh();
  }

  /** Eigene Sichtung zurücknehmen. */
  async remove(id: string): Promise<void> {
    const ev = this.eventId;
    if (!ev) return;
    const s = this.list.find((x) => x.id === id);
    if (!s?.mine) return;
    this.list = this.list.filter((x) => x.id !== id);
    save(ev, this.list);
    this.onChange();
    if (!s.pending) {
      try {
        await deleteSighting(id);
      } catch {
        this.state = 'offline';
      }
      await this.refresh();
    }
  }
}
