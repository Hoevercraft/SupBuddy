/*
 * Verbindung zu Supabase (geteilte Sichtungen). Ohne Bibliothek, nur fetch:
 * klein und läuft genauso in einer Capacitor-WebView.
 *
 * Der „publishable key“ ist öffentlich (landet in jedem Browser) und darf im Repo stehen.
 * Die Sicherheit liegt in der Datenbank: Tabelle nicht veröffentlicht, Zugriff nur über
 * geprüfte Funktionen (supabase/schema.sql). Geheime Schlüssel gehören NIE hierher.
 */

export const SUPABASE_URL = 'https://uldwwhedugbygaukjkly.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_k5lTVxYFROnQEBCDw0B4DQ_ZJNpmKcw';

const AUTH_KEY = 'supbuddy:auth';

/**
 * Automatisierte Browser (Tests) sprechen nie den echten Dienst an: dort gilt die
 * Adresse der Test-Attrappe (window.__supbuddyBackendUrl) bzw. eine ungültige.
 */
function baseUrl(): string {
  if (typeof navigator !== 'undefined' && navigator.webdriver) {
    return (window as unknown as { __supbuddyBackendUrl?: string }).__supbuddyBackendUrl ?? 'https://backend.invalid';
  }
  return SUPABASE_URL;
}
const TIMEOUT_MS = 10_000;

interface Session {
  access_token: string;
  refresh_token: string;
  /** Sekunden seit 1970 */
  expires_at: number;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(path: string, init: RequestInit & { token?: string } = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new BackendError(String(data?.message ?? data?.msg ?? res.statusText), res.status);
    return data;
  } catch (e) {
    if (e instanceof BackendError) throw e;
    throw new BackendError(ctrl.signal.aborted ? 'Zeitüberschreitung' : 'Nicht erreichbar', 0);
  } finally {
    clearTimeout(timer);
  }
}

function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_KEY) ?? 'null');
    return s && typeof s.access_token === 'string' ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(AUTH_KEY, JSON.stringify(s));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    // ohne Speicher eben pro Sitzung neu
  }
}

function toSession(data: unknown): Session {
  const d = data as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
  if (!d?.access_token || !d.refresh_token) throw new BackendError('Anmeldung fehlgeschlagen', 500);
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at ?? Math.floor(Date.now() / 1000) + (d.expires_in ?? 3600),
  };
}

let pending: Promise<Session> | null = null;

/** Anonyme Anmeldung (unsichtbar): gültiges Zugangs-Token, bei Bedarf erneuert. */
async function session(): Promise<Session> {
  const s = loadSession();
  if (s && s.expires_at - 60 > Date.now() / 1000) return s;
  if (!pending) {
    pending = (async () => {
      try {
        if (s) {
          try {
            const r = toSession(
              await request('/auth/v1/token?grant_type=refresh_token', {
                method: 'POST',
                body: JSON.stringify({ refresh_token: s.refresh_token }),
              }),
            );
            saveSession(r);
            return r;
          } catch (e) {
            if (e instanceof BackendError && e.status === 0) throw e; // offline: nicht neu anmelden
          }
        }
        const r = toSession(await request('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ data: {} }) }));
        saveSession(r);
        return r;
      } finally {
        pending = null;
      }
    })();
  }
  return pending;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let s = await session();
  try {
    return (await request(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args), token: s.access_token })) as T;
  } catch (e) {
    // Token abgelaufen/ungültig → einmal neu anmelden
    if (e instanceof BackendError && e.status === 401) {
      saveSession(null);
      s = await session();
      return (await request(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args), token: s.access_token })) as T;
    }
    throw e;
  }
}

export interface RemoteSighting {
  id: string;
  athlete_id: string;
  along_m: number;
  seen_at: string;
  mine: boolean;
}

export const fetchSightings = (eventId: string) => rpc<RemoteSighting[]>('get_sightings', { p_event: eventId });

export async function addSighting(eventId: string, athleteId: string, along: number, seenAt: number): Promise<RemoteSighting> {
  const rows = await rpc<RemoteSighting[]>('add_sighting', {
    p_event: eventId,
    p_athlete: athleteId,
    p_along: Math.round(along),
    p_seen: new Date(seenAt).toISOString(),
  });
  if (!rows?.[0]) throw new BackendError('Keine Antwort', 500);
  return rows[0];
}

export const deleteSighting = (id: string) => rpc<boolean>('delete_sighting', { p_id: id });

export interface RemoteEvent {
  /** Event im Link-Format (komprimiert, Base64url); null wenn abgelaufen */
  data: string | null;
  version: number;
  /** Wann der Server das Event löscht (ms) */
  expiresAt: number;
  expired: boolean;
}

/** Geteiltes Event holen; null = auf dem Server (noch) nicht vorhanden. */
export async function fetchEvent(eventId: string): Promise<RemoteEvent | null> {
  const rows = await rpc<{ data: string | null; version: number; expires_at: string; expired: boolean }[]>('get_event', { p_event: eventId });
  const r = rows?.[0];
  return r ? { data: r.data, version: r.version, expiresAt: Date.parse(r.expires_at), expired: !!r.expired } : null;
}

export class ConflictError extends Error {}
/** Event ist abgelaufen (Daten gelöscht, wird nicht mehr geteilt). */
export class ExpiredError extends Error {}

export const isExpiredError = (e: unknown) => e instanceof BackendError && (e.status === 410 || /Abgelaufen/.test(e.message));

/**
 * Event speichern; baseVersion = Version, auf der die Änderung beruht (0 = neu).
 * raceDate bestimmt, wann der Server das Event löscht (2 Tage nach dem Renntag).
 */
export async function putEvent(eventId: string, data: string, baseVersion: number, raceDate: string | null): Promise<number> {
  try {
    return await rpc<number>('put_event', { p_event: eventId, p_data: data, p_base_version: baseVersion, p_race_date: raceDate });
  } catch (e) {
    if (e instanceof BackendError && /Konflikt/.test(e.message)) throw new ConflictError('Konflikt');
    if (isExpiredError(e)) throw new ExpiredError('Abgelaufen');
    throw e;
  }
}

// ---------------------------------------------------------------- Live-Tracking (Stufe 6)

export interface RemotePosition {
  /** Athleten-Kennung */
  a: string;
  /** Zeitpunkt der Messung (ISO) */
  t: string;
  lat: number;
  lon: number;
  /** Genauigkeit in m */
  acc: number | null;
  /** Geschwindigkeit in m/s */
  v: number | null;
}

export interface RemoteLive {
  /** Athleten mit eingerichtetem Tracking */
  trackers: string[];
  positions: RemotePosition[];
  /** Serverzeit der Antwort (für den nächsten Abruf „seit“) */
  now: string;
}

/** Live-Stand eines Events; since = nur Positionen, die danach empfangen wurden. */
export const fetchLive = (eventId: string, since: string | null) =>
  rpc<RemoteLive>('get_live', { p_event: eventId, p_since: since });

/** Tracking für einen Athleten einrichten (gibt es schon eins: dasselbe Token). */
export const createTracker = (eventId: string, athleteId: string) =>
  rpc<string>('create_tracker', { p_event: eventId, p_athlete: athleteId });

/** Tracking beenden: Token ungültig, Positionen gelöscht. */
export const deleteTracker = (eventId: string, athleteId: string) =>
  rpc<boolean>('delete_tracker', { p_event: eventId, p_athlete: athleteId });

/**
 * Adresse, an die Traccar Client sendet (direkt die Datenbankfunktion `track`).
 * Bewusst die echte Adresse, auch in Tests: sie landet nur im Einrichtungslink.
 */
export const trackUrl = () => `${SUPABASE_URL}/rest/v1/rpc/track?apikey=${SUPABASE_KEY}`;
