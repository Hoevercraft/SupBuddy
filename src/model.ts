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

/** Pace je Disziplin, in den Einheiten, in denen Sportler sie kennen. */
export interface Pace {
  /** Sekunden pro 100 m */
  schwimmen: number;
  /** km/h */
  rad: number;
  /** Sekunden pro km */
  lauf: number;
}

export interface Athlete {
  /** Kennung für Sichtungen (über Geräte hinweg gleich) */
  id?: string;
  name: string;
  color: string;
  /** Startzeit am Renntag, "HH:MM" (Ortszeit) */
  start: string;
  pace: Pace;
  /** Dauer je Wechsel in Sekunden (T1/T2 oder Wechsel-Etappe) */
  transition: number;
}

export const DEFAULT_PACE: Pace = { schwimmen: 120, rad: 30, lauf: 330 };
export const DEFAULT_TRANSITION = 180;

/** Gut unterscheidbare Athletenfarben, die sich von den Disziplinfarben abheben. */
export const ATHLETE_COLORS = ['#d62839', '#1d4ed8', '#0f766e', '#a21caf', '#b45309', '#334155'];

export interface RaceEvent {
  /** Kennung des Events (steckt im Teilen-Link; Sichtungen hängen daran) */
  id?: string;
  name: string;
  legs: Leg[];
  /** Renntag "YYYY-MM-DD"; null = heute */
  date: string | null;
  athletes: Athlete[];
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
