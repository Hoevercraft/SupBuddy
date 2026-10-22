import { mmss, relative } from './format';
import type { Discipline } from './model';
import type { LiveView } from './live';
import qrcodegen from './vendor/qrcodegen';

/* Oberfläche zum Live-Tracking: Zeile beim Athleten und Einrichtung im Athleten-Dialog. */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Gemessenes Tempo in der Einheit der Disziplin. */
export function speedText(d: Discipline, v: number): string {
  switch (d) {
    case 'rad':
      return `${(v * 3.6).toFixed(1).replace('.', ',')} km/h`;
    case 'lauf':
      return `${mmss(1000 / v)} min/km`;
    case 'schwimmen':
      return `${mmss(100 / v)} min/100 m`;
    default:
      return '';
  }
}

/** „● Live · vor 1 min · Ø 31,2 km/h“ bzw. „Zuletzt live vor 7 min“. */
export function liveLine(lv: LiveView, now: number): string {
  if (!lv.tracking) return '';
  if (lv.lastAt === null) return 'Live-Tracking eingerichtet – noch keine Position';
  const ago = now - lv.lastAt < 60_000 ? 'gerade eben' : relative(lv.lastAt, now);
  const avg = lv.fix?.measured ? ` · Ø ${speedText(lv.fix.discipline, lv.fix.measured)}` : '';
  if (now - lv.lastAt >= 5 * 60_000) return `Zuletzt live ${ago}${avg}`;
  if (!lv.onCourse) return `Live ${ago} · nicht an der Strecke`;
  if (!lv.fix) return `Live ${ago}`;
  if (lv.fix.waiting) return `Live ${ago} · am Start`;
  return `Live ${ago}${avg}`;
}

/** QR-Code als SVG (schwarz auf weiß, mit Rand). */
export function qrSvg(text: string): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.LOW);
  const n = qr.size;
  const border = 3;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.getModule(x, y)) d += `M${x + border},${y + border}h1v1h-1z`;
  const s = n + border * 2;
  return `<svg class="qr" data-testid="live-qr" viewBox="0 0 ${s} ${s}" role="img" aria-label="QR-Code zum Einrichten" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export type LiveSetup =
  | { kind: 'new' }
  | { kind: 'not-shared' }
  | { kind: 'idle'; busy: boolean }
  | { kind: 'ready'; name: string; link: string };

/** Abschnitt „Live-Tracking“ im Athleten-Dialog. */
export function liveSetupHtml(s: LiveSetup): string {
  const head = '<h3>Live-Tracking</h3>';
  switch (s.kind) {
    case 'new':
      return '';
    case 'not-shared':
      return `${head}<p class="hint">Geht, sobald das Event geteilt ist (Bereich Strecke → „Link teilen“).</p>`;
    case 'idle':
      return `${head}
        <p class="hint">Der Athlet sendet mit der kostenlosen App „Traccar Client“ alle 15 Sekunden seinen Standort. Alle mit eurem Link sehen ihn dann live – Sichtungen und Pace braucht es für ihn nicht mehr.</p>
        <button type="button" class="btn" id="live-create"${s.busy ? ' disabled' : ''}>${s.busy ? 'Wird eingerichtet …' : 'Live-Tracking einrichten'}</button>`;
    case 'ready':
      return `${head}
        <ol class="live-steps">
          <li>„Traccar Client“ installieren (kostenlos): <a href="https://apps.apple.com/app/traccar-client/id843156974" target="_blank" rel="noopener">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=org.traccar.client" target="_blank" rel="noopener">Android</a></li>
          <li>Auf dem Handy von ${esc(s.name)}: QR-Code mit der Kamera scannen oder „In Traccar öffnen“ tippen und bestätigen.</li>
          <li>Standort für Traccar auf <strong>„Immer“</strong> erlauben (mit „Genauer Standort“).</li>
          <li>Kurz vor dem Start „Kontinuierliche Standortverfolgung“ einschalten, nach dem Ziel aus.</li>
        </ol>
        ${qrSvg(s.link)}
        <div class="actions">
          <a class="btn btn-primary" id="live-open" data-testid="live-open" href="${esc(s.link)}">In Traccar öffnen</a>
          <button type="button" class="btn" id="live-copy">Link kopieren</button>
        </div>
        <p class="hint">Gesendet wird nur am Renntag. Die Positionen sehen alle mit eurem Link; sie werden mit dem Event gelöscht.</p>
        <button type="button" class="btn btn-quiet btn-danger" id="live-delete">Live-Tracking beenden</button>`;
  }
}
