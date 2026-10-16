/** Uhrzeit „10:42“ in Ortszeit, auf die Minute gerundet. */
export function clock(ms: number): string {
  return new Date(Math.round(ms / 60_000) * 60_000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Dauer „23 min“ / „1 h 05 min“ / „2 Tage“. */
export function duration(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.round(h / 24)} Tage`;
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/** „in 23 min“ bzw. „vor 23 min“. */
export function relative(ms: number, now: number): string {
  const d = ms - now;
  if (Math.abs(d) < 60_000) return 'jetzt';
  return d > 0 ? `in ${duration(d)}` : `vor ${duration(d)}`;
}

/** Sekunden → „5:30“. */
export function mmss(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** „5:30“, „5“, „5,5“ → Sekunden; null wenn unlesbar. */
export function parseMmss(text: string): number | null {
  const t = text.trim().replace(',', '.');
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (m) {
    const sec = Number(m[2]);
    return sec < 60 ? Number(m[1]) * 60 + sec : null;
  }
  const n = Number(t);
  return t !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 60) : null;
}

/** Lokales Datum „YYYY-MM-DD“. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
