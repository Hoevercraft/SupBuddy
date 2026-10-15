/** Längen-/Breitengrad, optional mit Höhe in Metern. */
export type LngLat = [lng: number, lat: number];
export type Point = { lng: number; lat: number; ele?: number };

export type Discipline = 'schwimmen' | 'rad' | 'lauf' | 'wechsel';

export const DISCIPLINES: Record<Discipline, { label: string; color: string }> = {
  schwimmen: { label: 'Schwimmen', color: '#3b9cff' },
  rad: { label: 'Rad', color: '#ff8a3d' },
  lauf: { label: 'Lauf', color: '#3ddc84' },
  wechsel: { label: 'Wechsel', color: '#c58cff' },
};

export interface Leg {
  name: string;
  discipline: Discipline;
  points: Point[];
  /** Positive Höhenmeter, beim Import aus der Originaldatei berechnet. */
  elevationGain: number | null;
}

export interface RaceEvent {
  name: string;
  legs: Leg[];
}

export type EventKind = 'Radrennen' | 'Lauf' | 'Triathlon' | 'Rennen';

export function eventKind(ev: RaceEvent): EventKind {
  const set = new Set(ev.legs.map((l) => l.discipline).filter((d) => d !== 'wechsel'));
  if (set.has('schwimmen') || set.size > 1) return 'Triathlon';
  if (set.has('rad')) return 'Radrennen';
  if (set.has('lauf')) return 'Lauf';
  return 'Rennen';
}

/** Rät die Disziplin aus einem Etappen- oder Dateinamen. */
export function guessDiscipline(name: string, fallback: Discipline = 'rad'): Discipline {
  const n = name.toLowerCase();
  if (/(swim|schwimm|wasser)/.test(n)) return 'schwimmen';
  if (/(^|[^a-z])(t1|t2)([^a-z0-9]|$)|wechsel|transition/.test(n)) return 'wechsel';
  if (/\brun(ning)?\b|lauf|marathon|\b(5|10|21|42)\s?k(m)?\b/.test(n)) return 'lauf';
  if (/(bike|rad|cycl|velo|ride|gravel)/.test(n)) return 'rad';
  return fallback;
}
