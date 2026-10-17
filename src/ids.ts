import type { RaceEvent } from './model';

/*
 * Kennungen für Event und Athleten. Sichtungen werden darüber zwischen den Geräten zugeordnet.
 * Neue Events/Athleten bekommen Zufalls-Kennungen. Ältere Events (aus Links ohne Kennung)
 * bekommen eine aus dem Inhalt berechnete – so kommen alle Empfänger desselben Links auf dieselbe.
 */

export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Zufalls-Kennung (Standard 22 Zeichen ≈ 132 bit – nicht erratbar). */
export function randomId(length = 22): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join('');
}

/** 53-bit-Hash (cyrb53) als Text – stabil auf allen Geräten. */
export function hashId(text: string, prefix: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${prefix}${n.toString(36).padStart(11, '0')}`;
}

/** Fingerabdruck der Strecke (Etappen, Punktzahl, Anfang/Ende). */
export function courseKey(ev: RaceEvent): string {
  return ev.legs
    .map((l) => {
      const a = l.points[0];
      const b = l.points[l.points.length - 1];
      return `${l.points.length}:${a?.lat.toFixed(5)},${a?.lng.toFixed(5)}:${b?.lat.toFixed(5)},${b?.lng.toFixed(5)}`;
    })
    .join('|');
}

/** Fehlende Kennungen ergänzen (aus dem Inhalt berechnet, damit alle Geräte dieselben bekommen). */
export function withIds(ev: RaceEvent): RaceEvent {
  const id = ev.id && ID_RE.test(ev.id) ? ev.id : hashId(`${ev.name}|${ev.date ?? ''}|${courseKey(ev)}`, 'h');
  let changed = id !== ev.id;
  const athletes = ev.athletes.map((a, i) => {
    if (a.id && ID_RE.test(a.id)) return a;
    changed = true;
    return { ...a, id: hashId(`${i}|${a.name}|${a.start}`, 'a') };
  });
  return changed ? { ...ev, id, athletes } : ev;
}

/**
 * Kennungen aus dem zuletzt geöffneten Link übernehmen (gleiche Strecke vorausgesetzt).
 * Hilft, wenn eine ältere App-Version den Link ohne Kennungen gespeichert hat und erst danach
 * die neue Version geladen wurde. Athleten werden über Name + Startzeit zugeordnet;
 * sonst bleibt alles, wie es lokal ist.
 */
export function adoptIds(saved: RaceEvent, linked: RaceEvent): RaceEvent {
  if (courseKey(saved) !== courseKey(linked)) return saved;
  const used = new Set<number>();
  const athletes = saved.athletes.map((a) => {
    const j = linked.athletes.findIndex((l, k) => !used.has(k) && l.name === a.name && l.start === a.start && !!l.id);
    if (j < 0) return a;
    used.add(j);
    return a.id === linked.athletes[j].id ? a : { ...a, id: linked.athletes[j].id };
  });
  const id = linked.id ?? saved.id;
  const changed = id !== saved.id || athletes.some((a, i) => a !== saved.athletes[i]);
  return changed ? { ...saved, id, athletes } : saved;
}
