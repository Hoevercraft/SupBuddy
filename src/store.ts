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

export async function loadEvent(): Promise<RaceEvent | null> {
  try {
    const token = localStorage.getItem(KEY);
    return token ? await decodeEvent(token) : null;
  } catch {
    return null;
  }
}
