import type { RaceEvent } from './model';
import { decodeEvent, encodeEvent } from './share';

const KEY = 'supbuddy:event';

/** Speichert das aktuelle Event lokal (im selben kompakten Format wie der Teilen-Link). */
export async function saveEvent(ev: RaceEvent | null): Promise<void> {
  try {
    if (ev) localStorage.setItem(KEY, await encodeEvent(ev));
    else localStorage.removeItem(KEY);
  } catch {
    // Privater Modus o. Ä.: dann eben ohne Speichern
  }
}

const LINK_KEY = 'supbuddy:last-link';

/** Zuletzt geöffneter Teilen-Link + App-Version, mit der er gelesen wurde. */
export function saveLastLink(token: string, build: string): void {
  try {
    localStorage.setItem(LINK_KEY, JSON.stringify({ token, build }));
  } catch {
    // egal
  }
}

export function loadLastLink(): { token: string; build: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LINK_KEY) ?? 'null');
    return v && typeof v.token === 'string' && typeof v.build === 'string' ? v : null;
  } catch {
    return null;
  }
}

export async function loadEvent(): Promise<RaceEvent | null> {
  try {
    const token = localStorage.getItem(KEY);
    return token ? await decodeEvent(token) : null;
  } catch {
    return null;
  }
}
