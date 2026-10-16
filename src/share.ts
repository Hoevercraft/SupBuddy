import { simplify } from './geo';
import { DISCIPLINES, type Athlete, type Discipline, type Leg, type Point, type RaceEvent } from './model';

/*
 * Ein Event wird komplett in den Link gepackt (Hash-Teil, wird nie an einen Server gesendet):
 *   #e=<base64url(deflate-raw(JSON))>
 * Koordinaten als Delta-Ganzzahlfolge im Polyline-Stil (1e-5 Grad ≈ 1 m), Höhe in ganzen Metern.
 */

const FORMAT_VERSION = 1;
const COORD_FACTOR = 1e5;
/** Toleranz für die Vereinfachung beim Speichern/Teilen. */
export const STORE_TOLERANCE_M = 3;

// ---------- Ganzzahlfolgen als kompakter Text (Google-Polyline-Algorithmus) ----------

export function encodeInts(values: number[]): string {
  let out = '';
  let prev = 0;
  for (const v of values) {
    let delta = v - prev;
    prev = v;
    let n = delta < 0 ? ~(delta << 1) : delta << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>>= 5;
    }
    out += String.fromCharCode(n + 63);
  }
  return out;
}

export function decodeInts(str: string): number[] {
  const out: number[] = [];
  let i = 0;
  let prev = 0;
  while (i < str.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= str.length) throw new Error('Kodierung unvollständig');
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const delta = result & 1 ? ~(result >> 1) : result >> 1;
    prev += delta;
    out.push(prev);
  }
  return out;
}

// ---------- Event <-> kompaktes JSON ----------

interface WireLeg {
  n: string;
  d: Discipline;
  /** lat/lng verschachtelt: lat0,lng0,lat1,lng1,… */
  p: string;
  /** Höhen (optional) */
  e?: string;
  /** Höhenmeter */
  g?: number;
}
interface WireAthlete {
  n: string;
  c: string;
  /** Start "HH:MM" */
  s: string;
  /** Pace: [s/100 m Schwimmen, km/h×10 Rad, s/km Lauf] */
  p: [number, number, number];
  /** Wechsel in s */
  w: number;
}
interface WireEvent {
  v: number;
  n: string;
  l: WireLeg[];
  /** Renntag (optional) */
  d?: string;
  /** Athleten (optional; ältere Links haben keine) */
  a?: WireAthlete[];
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function athleteToWire(a: Athlete): WireAthlete {
  return {
    n: a.name,
    c: a.color,
    s: a.start,
    p: [Math.round(a.pace.schwimmen), Math.round(a.pace.rad * 10), Math.round(a.pace.lauf)],
    w: Math.round(a.transition),
  };
}

function athleteFromWire(w: WireAthlete): Athlete {
  const ok =
    w &&
    typeof w.n === 'string' &&
    COLOR_RE.test(w.c) &&
    TIME_RE.test(w.s) &&
    Array.isArray(w.p) &&
    w.p.length === 3 &&
    w.p.every((x) => Number.isFinite(x) && x > 0) &&
    Number.isFinite(w.w) &&
    w.w >= 0;
  if (!ok) throw new Error('Athlet im Link ist beschädigt');
  return {
    name: w.n.slice(0, 40),
    color: w.c,
    start: w.s,
    pace: { schwimmen: w.p[0], rad: w.p[1] / 10, lauf: w.p[2] },
    transition: w.w,
  };
}

function legToWire(leg: Leg): WireLeg {
  const pts = simplify(leg.points, STORE_TOLERANCE_M);
  const coords: number[] = [];
  for (const p of pts) coords.push(Math.round(p.lat * COORD_FACTOR), Math.round(p.lng * COORD_FACTOR));
  const wire: WireLeg = { n: leg.name, d: leg.discipline, p: encodeInts(coords) };
  if (pts.every((p) => typeof p.ele === 'number')) wire.e = encodeInts(pts.map((p) => Math.round(p.ele!)));
  if (leg.elevationGain != null) wire.g = Math.round(leg.elevationGain);
  return wire;
}

function legFromWire(w: WireLeg): Leg {
  if (typeof w.n !== 'string' || typeof w.p !== 'string' || !(w.d in DISCIPLINES)) {
    throw new Error('Etappe im Link ist beschädigt');
  }
  const coords = decodeInts(w.p);
  if (coords.length % 2 !== 0) throw new Error('Koordinaten im Link sind beschädigt');
  const eles = w.e ? decodeInts(w.e) : null;
  const points: Point[] = [];
  for (let i = 0; i < coords.length; i += 2) {
    const p: Point = { lat: coords[i] / COORD_FACTOR, lng: coords[i + 1] / COORD_FACTOR };
    const ele = eles?.[i / 2];
    if (ele !== undefined) p.ele = ele;
    points.push(p);
  }
  return { name: w.n, discipline: w.d, points, elevationGain: typeof w.g === 'number' ? w.g : null };
}

/** Bringt eine Etappe in genau die Form, die auch ein Link-Empfänger bekommt (vereinfacht, gerundet). */
export function normalizeLeg(leg: Leg): Leg {
  return legFromWire(legToWire(leg));
}

export function eventToWire(ev: RaceEvent): WireEvent {
  const wire: WireEvent = { v: FORMAT_VERSION, n: ev.name, l: ev.legs.map(legToWire) };
  if (ev.date) wire.d = ev.date;
  if (ev.athletes.length) wire.a = ev.athletes.map(athleteToWire);
  return wire;
}

export function eventFromWire(data: unknown): RaceEvent {
  const w = data as Partial<WireEvent>;
  if (!w || typeof w !== 'object' || w.v !== FORMAT_VERSION || !Array.isArray(w.l)) {
    throw new Error('Unbekanntes oder beschädigtes Event-Format');
  }
  return {
    name: typeof w.n === 'string' ? w.n : 'Rennen',
    legs: w.l.map(legFromWire),
    date: typeof w.d === 'string' && DATE_RE.test(w.d) ? w.d : null,
    athletes: Array.isArray(w.a) ? w.a.map(athleteFromWire) : [],
  };
}

// ---------- Kompression + Base64url ----------

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function encodeEvent(ev: RaceEvent): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(eventToWire(ev)));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeEvent(token: string): Promise<RaceEvent> {
  const bytes = await pipe(fromBase64Url(token), new DecompressionStream('deflate-raw'));
  return eventFromWire(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Liest ein Event aus einem Hash wie "#e=…", sonst null. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)e=([A-Za-z0-9_-]+)/.exec(hash);
  return m ? m[1] : null;
}

export async function shareUrl(ev: RaceEvent, base: string): Promise<string> {
  const url = new URL(base);
  url.hash = `e=${await encodeEvent(ev)}`;
  return url.toString();
}
