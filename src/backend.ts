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
