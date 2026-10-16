import { MODES, passTimes, type Mode } from './cheer';
import { legDistance, type CourseNearest } from './course';
import { clock, duration } from './format';
import { formatDistance, formatKm } from './geo';
import { DISCIPLINES, type RaceEvent } from './model';
import { isApple } from './plan-ui';
import { appleMapsUrl, googleMapsUrl, viaPoints, type Route } from './routing';

/*
 * Kleine Karte am angetippten Streckenpunkt: wann kommen die Athleten hier vorbei,
 * und – auf Wunsch – wie komme ich hin und reicht das?
 */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PickView {
  n: CourseNearest;
  mode: Mode;
  speed: number;
  /** Athlet, für den das Urteil („rechtzeitig?“) gilt */
  athleteIndex: number;
  route: Route | null;
  /** Ankunftszeit (ms), wenn jetzt losgegangen wird */
  arrive: number | null;
  busy: boolean;
  /** Standort wird gerade gesucht */
  locating: boolean;
  hasPosition: boolean;
  now: number;
}

/** Überschrift: Start/Ziel oder km (bei mehreren Etappen mit Disziplin). */
export function pickTitle(ev: RaceEvent, n: CourseNearest): string {
  const total = ev.legs.reduce((sum, l) => sum + legDistance(l), 0);
  if (n.along >= total - 50) return 'Ziel';
  if (n.along <= 50) return 'Start';
  const km = formatKm(n.along).replace(' km', '');
  const leg = ev.legs[n.legIndex];
  return `km ${km}${ev.legs.length > 1 && leg ? ` · ${DISCIPLINES[leg.discipline].label}` : ''}`;
}

/** Minuten zwischen zwei Zeitpunkten, passend zu den gerundeten Uhrzeiten. */
const minutes = (a: number, b: number) => Math.round(a / 60_000) - Math.round(b / 60_000);

export function pickHtml(ev: RaceEvent, v: PickView): string {
  const today = new Date(v.now);
  const times = passTimes(ev, ev.athletes, v.n.along, today);
  const mode = MODES[v.mode];

  const athletes = ev.athletes.length
    ? `<ul class="pick-athletes">${ev.athletes
        .map((a, i) => {
          const t = times[i];
          let verdict = '';
          if (t < v.now) verdict = ' · schon vorbei';
          else if (v.arrive !== null) {
            const m = minutes(t, v.arrive);
            verdict =
              m >= 0
                ? ` · <span class="ok" data-testid="pick-ok">du bist ${m === 0 ? 'gerade so' : `${duration(m * 60_000)} vorher`} da ✓</span>`
                : ` · <span class="late" data-testid="pick-late">${duration(-m * 60_000)} zu spät</span>`;
          }
          const main = i === v.athleteIndex;
          return `<li class="${main ? 'main' : ''}${t < v.now ? ' missed' : ''}" style="--athlete-color:${a.color}">${esc(a.name)} ca. ${clock(t)}${verdict}</li>`;
        })
        .join('')}</ul>`
    : '<p class="pick-hint">Trag Athleten ein, dann siehst du hier, wann sie vorbeikommen.</p>';

  const modes = (Object.keys(MODES) as Mode[])
    .map((m) => `<button type="button" class="seg-btn" data-pick-mode="${m}" aria-pressed="${m === v.mode}">${MODES[m].label}</button>`)
    .join('');

  let way = '';
  if (v.route && v.arrive !== null) {
    const travel = v.arrive - v.now;
    const via = viaPoints(v.route);
    const to = v.n.point;
    const google = googleMapsUrl(to, v.mode, via);
    const nav = isApple()
      ? `<a class="btn btn-small" data-testid="pick-nav" href="${appleMapsUrl(to, v.mode, via)}" target="_blank" rel="noopener">Apple Karten</a>
         <a class="btn btn-small" data-testid="pick-nav-google" href="${google}" target="_blank" rel="noopener">Google Maps</a>`
      : `<a class="btn btn-small" data-testid="pick-nav" href="${google}" target="_blank" rel="noopener">Navigation</a>`;
    way = `
      <p class="pick-way" data-testid="pick-way">${formatDistance(v.route.distance)} ${mode.verb} · ca. ${duration(travel)}${v.route.routed ? '' : ' (geschätzt)'} · an ca. ${clock(v.arrive)}</p>
      ${v.route.crosses ? '<p class="stop-cross" data-testid="pick-cross">⚠ Weg quert die Strecke. Nur queren, wenn gerade niemand kommt.</p>' : ''}
      <div class="pick-actions">${nav}</div>`;
  }

  const button = v.route
    ? ''
    : `<button type="button" class="btn btn-primary btn-small pick-go" data-testid="pick-go"${v.busy || v.locating ? ' disabled' : ''}>${
        v.busy ? 'Suche Weg …' : v.locating ? 'Suche Standort …' : v.hasPosition ? 'Weg hierhin' : 'Standort holen & Weg zeigen'
      }</button>`;

  return `
    <div class="pick" data-testid="pick">
      <div class="pick-title" data-testid="pick-title">${esc(pickTitle(ev, v.n))}</div>
      ${athletes}
      <div class="seg seg-small" role="group" aria-label="Unterwegs zum Punkt">${modes}</div>
      ${way}
      ${button}
    </div>`;
}
