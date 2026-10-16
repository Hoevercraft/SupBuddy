/*
 * Blickrichtung für den eigenen Standort (wie der Lichtkegel in Google Maps).
 *
 * Quellen:
 * - Kompass des Handys (deviceorientation). iOS liefert `webkitCompassHeading` und braucht
 *   eine Erlaubnis, die nur nach einem Tippen abgefragt werden darf. Android/Chrome liefert
 *   `deviceorientationabsolute` (alpha gegen Norden).
 * - Fahrtrichtung aus dem GPS (coords.heading), sobald man sich zügig bewegt – dann ist sie
 *   verlässlicher als der Kompass (der z. B. am Rad-Lenker durch Metall abgelenkt wird).
 * Ohne Kompass (Desktop, manche WebViews) und im Stand gibt es keinen Kegel: lieber keiner als ein falscher.
 */

/** Ab diesem Tempo (m/s ≈ 7 km/h) zählt die GPS-Fahrtrichtung. */
export const GPS_MIN_SPEED = 2;
/** So lange bleibt eine GPS-Fahrtrichtung gültig. */
export const GPS_HOLD_MS = 5000;
/** Ohne neue Kompass-Werte so lange wird der Kegel ausgeblendet. */
export const COMPASS_HOLD_MS = 3000;

export interface OrientationLike {
  alpha: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

export const norm = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * Kompassrichtung (0 = Norden, im Uhrzeigersinn) der Oberkante des Bildschirms.
 * null, wenn das Gerät keine auf Norden bezogene Richtung liefert.
 */
export function compassHeading(e: OrientationLike, screenAngle: number): number | null {
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    // iOS: Richtung der Geräte-Oberkante; bei Querformat dreht der Bildschirm mit
    return norm(e.webkitCompassHeading + screenAngle);
  }
  if (e.absolute && typeof e.alpha === 'number') {
    // alpha zählt gegen den Uhrzeigersinn
    return norm(360 - e.alpha + screenAngle);
  }
  return null;
}

/**
 * Drehung des Bildschirms (0 = Hochformat). Manche Umgebungen melden im Hochformat 90°
 * – passt der Wert nicht zum Seitenverhältnis, gilt Hochformat.
 */
export function screenAngle(
  reported: number | undefined = typeof screen !== 'undefined' ? (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation) : 0,
  portrait: boolean = typeof window !== 'undefined' ? window.innerHeight >= window.innerWidth : true,
): number {
  const a = norm(Number(reported) || 0);
  if (portrait && (a === 90 || a === 270)) return 0;
  return a;
}

/** Halber Öffnungswinkel des Kegels: ungenauer Kompass → breiter Kegel. */
export function coneHalfAngle(accuracy: number | undefined): number {
  if (typeof accuracy !== 'number' || accuracy < 0) return 28;
  return Math.max(20, Math.min(55, accuracy));
}

/** Weich nachziehen über den kürzeren Weg (350° → 10° dreht über Norden). */
export function smooth(prev: number | null, next: number, factor = 0.35): number {
  if (prev === null) return norm(next);
  const delta = ((next - prev + 540) % 360) - 180;
  return norm(prev + delta * factor);
}

export interface HeadingState {
  compass: { deg: number; at: number; accuracy?: number } | null;
  gps: { deg: number; at: number } | null;
}

/** Welche Richtung wird gezeigt? GPS-Fahrtrichtung beim zügigen Bewegen, sonst Kompass. */
export function chooseHeading(s: HeadingState, now: number): { deg: number; half: number; source: 'gps' | 'kompass' } | null {
  if (s.gps && now - s.gps.at <= GPS_HOLD_MS) return { deg: s.gps.deg, half: 22, source: 'gps' };
  if (s.compass && now - s.compass.at <= COMPASS_HOLD_MS) return { deg: s.compass.deg, half: coneHalfAngle(s.compass.accuracy), source: 'kompass' };
  return null;
}

type PermissionFn = () => Promise<'granted' | 'denied' | 'default'>;

/** Sammelt Kompass- und GPS-Richtung und meldet die anzuzeigende Richtung. */
export class HeadingTracker {
  private state: HeadingState = { compass: null, gps: null };
  private shown: number | null = null;
  private listening = false;
  private timer: number | undefined;

  constructor(private onChange: (h: { deg: number; half: number; source: 'gps' | 'kompass' } | null) => void) {}

  /**
   * Kompass einschalten. Muss direkt aus einem Tippen heraus aufgerufen werden
   * (iOS fragt nur dann nach der Erlaubnis).
   */
  start(): void {
    if (this.listening || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
    const req = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn }).requestPermission;
    if (typeof req === 'function') {
      req.call(DeviceOrientationEvent)
        .then((r) => r === 'granted' && this.listen())
        .catch(() => undefined);
    } else {
      this.listen();
    }
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    // Android/Chrome: eigenes Ereignis mit Nordbezug; sonst (iOS) das normale mit webkitCompassHeading
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(type, (e) => this.onOrientation(e as DeviceOrientationEvent & OrientationLike));
    this.ensureTimer();
  }

  /** Werte veralten (Kompass aus, GPS-Fahrt vorbei) → regelmäßig neu entscheiden. */
  private ensureTimer(): void {
    if (this.timer === undefined) this.timer = window.setInterval(() => this.emit(), 1000);
  }

  private onOrientation(e: OrientationLike): void {
    const deg = compassHeading(e, screenAngle());
    if (deg === null) return;
    this.state.compass = { deg, at: Date.now(), accuracy: e.webkitCompassAccuracy };
    this.emit();
  }

  /** GPS-Fix übernehmen (Richtung nur bei zügiger Bewegung). */
  updateGps(coords: { heading: number | null; speed: number | null }): void {
    if (coords.heading !== null && Number.isFinite(coords.heading) && (coords.speed ?? 0) >= GPS_MIN_SPEED) {
      this.state.gps = { deg: norm(coords.heading), at: Date.now() };
      this.ensureTimer();
      this.emit();
    }
  }

  private emit(): void {
    const h = chooseHeading(this.state, Date.now());
    if (!h) {
      this.shown = null;
      return this.onChange(null);
    }
    this.shown = smooth(this.shown, h.deg);
    this.onChange({ ...h, deg: this.shown });
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
