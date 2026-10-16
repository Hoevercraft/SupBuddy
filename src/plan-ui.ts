import { MODES, passTimes, type Mode } from './cheer';
import { legDistance } from './course';
import { clock, duration, relative } from './format';
import { formatDistance, formatKm } from './geo';
import { DISCIPLINES, type RaceEvent } from './model';
import type { Plan, PlanSettings } from './plan';
import { appleMapsUrl, googleMapsUrl } from './routing';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const km = (m: number) => formatKm(m).replace(' km', '');
const nb = (s: string) => s.replace(/ /g, ' ');

const KEY = 'supbuddy:plan-settings';

/** Abstand zweier Durchgänge, passend zu den angezeigten (gerundeten) Uhrzeiten. */
function gap(t: number, ref: number): string {
  const min = Math.round(t / 60_000) - Math.round(ref / 60_000);
  if (min === 0) return 'gleichzeitig';
  return `${duration(Math.abs(min) * 60_000)} ${min > 0 ? 'später' : 'früher'}`;
}

export function loadSettings(ev: RaceEvent): PlanSettings {
  let saved: Partial<PlanSettings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    // ohne gespeicherte Einstellungen
  }
  const mode: Mode = saved.mode && saved.mode in MODES ? saved.mode : 'fuss';
  const speed = Number(saved.speed) >= 2 && Number(saved.speed) <= 40 ? Number(saved.speed) : MODES[mode].kmh;
  const maxStops = Number(saved.maxStops) >= 1 && Number(saved.maxStops) <= 5 ? Number(saved.maxStops) : 3;
  const athleteIndex = Number(saved.athleteIndex) >= 0 && Number(saved.athleteIndex) < ev.athletes.length ? Number(saved.athleteIndex) : 0;
  return { mode, speed, maxStops, athleteIndex };
}

export function saveSettings(s: PlanSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // egal
  }
}

function isApple(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export interface PlanView {
  settings: PlanSettings;
  plan: Plan | null;
  busy: boolean;
  /** Startpunkt ist der eigene Standort (sonst der Start der Strecke) */
  fromPosition: boolean;
  now: number;
}

export function planSection(ev: RaceEvent, view: PlanView): string {
  if (ev.athletes.length === 0) {
    return `
      <section class="cheer" aria-label="Anfeuer-Plan">
        <h3 class="sheet-sub">Anfeuer-Plan</h3>
        <p class="hint">Trag erst einen Athleten ein. Dann plant SupBuddy, wo du ihn wie oft anfeuern kannst.</p>
      </section>`;
  }
  const s = view.settings;
  const modeButtons = (Object.keys(MODES) as Mode[])
    .map(
      (m) =>
        `<button type="button" class="seg-btn" data-mode="${m}" aria-pressed="${m === s.mode}">${MODES[m].label}</button>`,
    )
    .join('');
  const athleteOptions = ev.athletes
    .map((a, i) => `<option value="${i}"${i === s.athleteIndex ? ' selected' : ''}>${esc(a.name)}</option>`)
    .join('');
  const stopOptions = [1, 2, 3, 4, 5]
    .map((n) => `<option value="${n}"${n === s.maxStops ? ' selected' : ''}>${n}</option>`)
    .join('');

  return `
    <section class="cheer" aria-label="Anfeuer-Plan">
      <h3 class="sheet-sub">Anfeuer-Plan</h3>
      <div class="seg" role="group" aria-label="Unterwegs">${modeButtons}</div>
      <div class="cheer-fields">
        <label>Für <select id="plan-athlete" aria-label="Plan für Athlet">${athleteOptions}</select></label>
        <label>Tempo <input id="plan-speed" inputmode="decimal" aria-label="Dein Tempo in km/h" value="${String(s.speed).replace('.', ',')}" /> km/h</label>
        <label>Stopps <select id="plan-stops" aria-label="Wunschanzahl Stopps">${stopOptions}</select></label>
      </div>
      <p class="hint cheer-from">${view.fromPosition ? 'Startpunkt: dein Standort.' : 'Startpunkt: Start der Strecke. Mit „Standort anzeigen“ planst du ab deinem Standort.'}</p>
      <button class="btn btn-primary btn-wide" id="btn-plan" type="button"${view.busy ? ' disabled' : ''}>${view.busy ? 'Plane Wege …' : 'Plan erstellen'}</button>
      ${view.plan ? planResult(ev, view.plan, view.now) : ''}
    </section>`;
}

function planResult(ev: RaceEvent, plan: Plan, now: number): string {
  const athlete = ev.athletes[plan.settings.athleteIndex];
  if (!athlete) return '';
  const mode = MODES[plan.settings.mode];
  const today = new Date(now);
  const total = ev.legs.reduce((sum, l) => sum + legDistance(l), 0);

  if (plan.stops.length === 0) {
    const tip = plan.settings.mode === 'fuss' ? ' Probier es mit Rad oder E-Scooter.' : '';
    return `<p class="plan-empty" data-testid="plan-empty">Von hier aus bist du nirgends mehr rechtzeitig vor ${esc(athlete.name)} an der Strecke.${tip}</p>`;
  }

  const legOf = (along: number) => {
    let off = 0;
    for (const l of ev.legs) {
      const len = legDistance(l);
      if (along <= off + len + 1) return l;
      off += len;
    }
    return ev.legs[ev.legs.length - 1];
  };

  const items = plan.stops
    .map((stop, i) => {
      const c = stop.candidate;
      const title =
        c.along >= total - 50
          ? 'Ziel'
          : c.along <= 50
            ? 'Start'
            : `km ${km(c.along)}${ev.legs.length > 1 ? ` · ${DISCIPLINES[legOf(c.along).discipline].label}` : ''}`;
      const way = `${formatDistance(stop.route.distance)} ${mode.verb} · ca. ${duration(stop.travel * 1000)}${stop.route.routed ? '' : ' (geschätzt)'}`;
      const times = passTimes(ev, ev.athletes, c.along, today)
        .map((t, j) => {
          const a = ev.athletes[j];
          const main = j === plan.settings.athleteIndex;
          const when =
            t < stop.arrive
              ? `schon vorbei (${clock(t)})`
              : main
                ? `ca. ${clock(t)}`
                : `ca. ${clock(t)} · ${nb(gap(t, stop.pass))}`;
          return `<li class="${main ? 'main' : ''}${t < stop.arrive ? ' missed' : ''}" style="--athlete-color:${a.color}">${esc(a.name)} ${esc(when)}</li>`;
        })
        .join('');
      const leave = stop.arrive - stop.travel * 1000;
      const nav = isApple() ? appleMapsUrl(c.point, plan.settings.mode) : googleMapsUrl(c.point, plan.settings.mode);
      return `
        <li class="stop" data-testid="stop">
          <span class="stop-num" aria-hidden="true">${i + 1}</span>
          <div class="stop-main">
            <div class="stop-title">${esc(title)}${stop.tight ? ' <span class="badge-tight">wird knapp</span>' : ''}</div>
            <div class="stop-way">${esc(way)}</div>
            <div class="stop-arrive" data-testid="stop-arrive">Los ${clock(leave)}${i === 0 ? ` (${esc(relative(leave, now))})` : ''} · an ca. ${clock(stop.arrive)}</div>
            <ul class="stop-athletes">${times}</ul>
            <div class="stop-actions">
              <button type="button" class="btn btn-small" data-show-stop="${i}">Weg zeigen</button>
              <a class="btn btn-small" data-testid="stop-nav" href="${nav}" target="_blank" rel="noopener">Navigation</a>
            </div>
          </div>
        </li>`;
    })
    .join('');

  const startInfo =
    plan.startTime > now + 60_000 ? `Aufbruch frühestens ${clock(plan.startTime)} (30 min vor dem Start).` : '';
  return `
    <div class="plan" data-testid="plan">
      <p class="plan-summary" data-testid="plan-summary">${esc(athlete.name)} ${plan.stops.length}× anfeuern${
        plan.stops.length < plan.settings.maxStops ? ` (mehr Stopps sind ${mode.verb} nicht zu schaffen)` : ''
      }. ${startInfo}</p>
      ${plan.estimated ? '<p class="hint" data-testid="plan-estimated">Wege nur geschätzt: Das Routing ist gerade nicht erreichbar.</p>' : ''}
      <ol class="stops">${items}</ol>
      <button class="btn btn-quiet" id="btn-plan-clear" type="button">Plan verwerfen</button>
    </div>`;
}
