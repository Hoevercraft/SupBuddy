import { BackendError, ConflictError, fetchEvent, putEvent } from './backend';
import type { Athlete, RaceEvent } from './model';
import { decodeEvent, encodeEvent, eventToWire } from './share';

/*
 * Stufe 5b: Das ganze Event (Strecke, Athleten, Renntag) läuft live für alle mit dem Link.
 *
 * Jedes Gerät merkt sich den zuletzt abgeglichenen Stand („Basis“) und dessen Version.
 * Eigene Änderungen werden kurz gesammelt und hochgeladen. Hat inzwischen jemand anders
 * geändert, lehnt der Server ab (Konflikt) → beide Stände werden zusammengeführt:
 * pro Feld bzw. pro Athlet gewinnt, wer gegenüber der Basis geändert hat (bei beiden: das eigene).
 *
 * Synchronisiert wird erst, wenn das Event geteilt wurde (Link geöffnet oder „Link teilen“).
 * Vorher bleibt alles auf dem Gerät.
 */

/** Inhaltlicher Vergleich (unabhängig davon, wie ein Browser komprimiert). */
export const canonical = (ev: RaceEvent) => JSON.stringify(eventToWire(ev));
const athleteKey = (a: Athlete) => JSON.stringify({ ...a, id: undefined });

/** Dreiwege-Zusammenführung: base = gemeinsamer Ausgangsstand. */
export function merge3(base: RaceEvent, local: RaceEvent, remote: RaceEvent): RaceEvent {
  const pick = <T>(b: T, l: T, r: T, eq: (x: T, y: T) => boolean = (x, y) => x === y): T => (eq(l, b) ? r : l);
  const legsEq = (x: RaceEvent['legs'], y: RaceEvent['legs']) =>
    JSON.stringify(eventToWire({ ...base, legs: x }).l) === JSON.stringify(eventToWire({ ...base, legs: y }).l);

  const byId = (list: Athlete[]) => new Map(list.filter((a) => a.id).map((a) => [a.id!, a]));
  const b = byId(base.athletes);
  const l = byId(local.athletes);
  const r = byId(remote.athletes);
  const out: Athlete[] = [];
  const seen = new Set<string>();
  const decide = (id: string): Athlete | null => {
    const inB = b.get(id);
    const inL = l.get(id);
    const inR = r.get(id);
    if (!inB) return inL ?? inR ?? null; // neu (auf einer Seite)
    const lChanged = !inL || athleteKey(inL) !== athleteKey(inB);
    const rChanged = !inR || athleteKey(inR) !== athleteKey(inB);
    if (!inL && !inR) return null;
    if (!inL) return rChanged ? inR! : null; // lokal gelöscht; remote unverändert → weg
    if (!inR) return lChanged ? inL : null; // remote gelöscht; lokal unverändert → weg
    return lChanged ? inL : inR;
  };
  // Reihenfolge: wie remote, neue lokale Athleten hinten an
  for (const a of [...remote.athletes, ...local.athletes]) {
    if (!a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    const d = decide(a.id);
    if (d) out.push(d);
  }
  // Athleten ohne Kennung (sollte nicht vorkommen) lokal behalten
  out.push(...local.athletes.filter((a) => !a.id));

  return {
    id: remote.id ?? local.id,
    name: pick(base.name, local.name, remote.name),
    date: pick(base.date, local.date, remote.date),
    legs: pick(base.legs, local.legs, remote.legs, legsEq),
    athletes: out,
  };
}

interface SyncState {
  version: number;
  /** canonical() des zuletzt abgeglichenen Stands */
  base: string;
  /** zuletzt abgeglichener Stand im Link-Format (für die Zusammenführung) */
  baseToken: string;
}

const KEY = (id: string) => `supbuddy:sync:${id}`;

function loadState(id: string): SyncState | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY(id)) ?? 'null');
    return s && Number.isInteger(s.version) && typeof s.base === 'string' && typeof s.baseToken === 'string' ? s : null;
  } catch {
    return null;
  }
}

function saveState(id: string, s: SyncState | null): void {
  try {
    if (s) localStorage.setItem(KEY(id), JSON.stringify(s));
    else localStorage.removeItem(KEY(id));
  } catch {
    // egal
  }
}

const ENABLED = (id: string) => `supbuddy:shared:${id}`;
export function isShared(id: string): boolean {
  try {
    return localStorage.getItem(ENABLED(id)) === '1';
  } catch {
    return false;
  }
}
function markShared(id: string): void {
  try {
    localStorage.setItem(ENABLED(id), '1');
  } catch {
    // egal
  }
}

export type EventSyncState = 'ok' | 'offline' | 'off';

export class EventSync {
  state: EventSyncState = 'off';
  private event: RaceEvent | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: number | undefined;

  /**
   * @param apply  übernimmt einen Stand vom Server (bzw. zusammengeführt) in die App
   * @param onState  Verbindungsstatus geändert
   */
  constructor(
    private apply: (ev: RaceEvent) => Promise<void>,
    private onState: () => void = () => {},
  ) {}

  private setState(s: EventSyncState): void {
    if (s !== this.state) {
      this.state = s;
      this.onState();
    }
  }

  /** Aktuelles Event (nach jeder Änderung aufrufen). local = vom Nutzer geändert → hochladen. */
  update(ev: RaceEvent | null, local: boolean): void {
    this.event = ev;
    if (!ev?.id || !isShared(ev.id)) {
      this.setState('off');
      return;
    }
    if (local) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(() => this.push()), 1200);
    }
  }

  /** Event wird geteilt (Link geöffnet oder „Link teilen“): ab jetzt abgleichen. */
  share(ev: RaceEvent): Promise<void> {
    if (!ev.id) return Promise.resolve();
    markShared(ev.id);
    this.event = ev;
    const id = ev.id;
    return this.run(async () => {
      // Ausgangsstand merken (der Link bzw. der Stand beim Teilen). Spätere eigene Änderungen
      // werden dagegen verglichen – so gehen sie auch nicht verloren, wenn der Server erst
      // später erreichbar ist oder inzwischen jemand anders etwas geändert hat.
      if (!loadState(id)) saveState(id, { version: 0, base: canonical(ev), baseToken: await encodeEvent(ev) });
      await this.pull();
    });
  }

  /** Stand vom Server holen (regelmäßig aufrufen). */
  refresh(): Promise<void> {
    if (!this.event?.id || !isShared(this.event.id)) return Promise.resolve();
    return this.run(() => this.pull());
  }

  /** Nacheinander ausführen, nie parallel. */
  private run(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn).catch(() => undefined);
    return this.chain;
  }

  private async pull(retry = 2): Promise<void> {
    const ev = this.event;
    if (!ev?.id) return;
    try {
      const remote = await fetchEvent(ev.id);
      if (this.event?.id !== ev.id) return;
      const st = loadState(ev.id);
      if (!remote) {
        // Noch nicht auf dem Server → eigenen Stand hochladen
        await this.push(retry);
        return;
      }
      const remoteEv: RaceEvent = { ...(await decodeEvent(remote.data)), id: ev.id };
      const current = this.event!;
      const remoteCanon = canonical(remoteEv);
      if (st && st.version === remote.version) {
        // Server unverändert: ggf. eigene Änderungen hochladen
        if (canonical(current) !== st.base) await this.push(retry);
        this.setState('ok');
        return;
      }
      const localChanged = st ? canonical(current) !== st.base : false;
      let next = remoteEv;
      if (localChanged && st) {
        const base: RaceEvent = { ...(await decodeEvent(st.baseToken)), id: ev.id };
        next = merge3(base, current, remoteEv);
      } else if (!st) {
        // Kein Ausgangsstand bekannt (ältere Version): Server gilt, aber nur hier
        // eingetragene Athleten gehen nicht verloren
        next = keepLocalOnly(remoteEv, current);
      }
      saveState(ev.id, { version: remote.version, base: remoteCanon, baseToken: remote.data });
      if (canonical(next) !== canonical(current)) await this.apply(next);
      if (canonical(next) !== remoteCanon) await this.push(retry);
      this.setState('ok');
    } catch {
      this.setState('offline');
    }
  }

  private async push(retry = 2): Promise<void> {
    const ev = this.event;
    if (!ev?.id || !isShared(ev.id)) return;
    const st = loadState(ev.id);
    const canon = canonical(ev);
    // Nichts Neues – außer das Event ist noch gar nicht auf dem Server (Version 0)
    if (st && st.version > 0 && st.base === canon) return;
    const token = await encodeEvent(ev);
    try {
      const version = await putEvent(ev.id, token, st?.version ?? 0);
      saveState(ev.id, { version, base: canon, baseToken: token });
      this.setState('ok');
    } catch (e) {
      if (e instanceof ConflictError && retry > 0) {
        // Jemand anders war schneller → holen, zusammenführen, nochmal
        await this.pull(retry - 1);
        return;
      }
      if (e instanceof BackendError || e instanceof ConflictError) this.setState('offline');
      else throw e;
    }
  }
}

/** Athleten, die es nur lokal gibt, an den Server-Stand anhängen. */
export function keepLocalOnly(remote: RaceEvent, local: RaceEvent): RaceEvent {
  const ids = new Set(remote.athletes.map((a) => a.id));
  const extra = local.athletes.filter((a) => a.id && !ids.has(a.id));
  return extra.length ? { ...remote, athletes: [...remote.athletes, ...extra] } : remote;
}
