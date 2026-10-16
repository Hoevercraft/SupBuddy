import { MODES, passTimes, type Mode } from './cheer';
import { legDistance } from './course';
import { clock, duration, relative } from './format';
import { formatDistance, formatKm } from './geo';
import { DISCIPLINES, type RaceEvent } from './model';
import type { Plan, PlanSettings } from './plan';
import { appleMapsUrl, googleMapsUrl, viaPoints } from './routing';
import { euro, LAENDER_URL, suggestTicket, TICKET_PRICES_AS_OF } from './tickets';
import { legLabel, rideLegs, type Journey } from './transit';

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
  const people = Number.isInteger(Number(saved.people)) && Number(saved.people) >= 1 && Number(saved.people) <= 30 ? Number(saved.people) : 1;
  return { mode, speed, maxStops, athleteIndex, people };
}

export function saveSettings(s: PlanSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // egal
  }
}

export function isApple(): boolean {
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
        ${
          s.mode === 'oepnv'
            ? `<label>Ihr seid <input id="plan-people" inputmode="numeric" aria-label="Anzahl Supporter" value="${s.people ?? 1}" /> ${(s.people ?? 1) === 1 ? 'Person' : 'Personen'}</label>`
            : `<label>Tempo <input id="plan-speed" inputmode="decimal" aria-label="Dein Tempo in km/h" value="${String(s.speed).replace('.', ',')}" /> km/h</label>`
        }
        <label>Stopps <select id="plan-stops" aria-label="Wunschanzahl Stopps">${stopOptions}</select></label>
      </div>
      <p class="hint cheer-from">${view.fromPosition ? 'Startpunkt: dein Standort.' : 'Startpunkt: Start der Strecke. Mit dem Standort-Knopf oben rechts planst du ab deinem Standort.'}</p>
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
      const j = stop.journey;
      const rides = j ? rideLegs(j) : [];
      const way = j
        ? `Bus & Bahn · ca. ${duration(stop.travel * 1000)}${rides.length > 1 ? ` · ${rides.length - 1}× umsteigen` : ''}`
        : `${formatDistance(stop.route.distance)} ${plan.settings.mode === 'oepnv' ? (stop.route.routed ? 'zu Fuß' : 'mit Bus & Bahn') : mode.verb} · ca. ${duration(stop.travel * 1000)}${stop.route.routed ? '' : ' (geschätzt)'}`;
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
      // Zwischenziele auf unserer Route: die Navi-App nimmt denselben Weg (ohne die Strecke zu queren)
      const via = plan.settings.mode === 'oepnv' ? [] : viaPoints(stop.route);
      const google = googleMapsUrl(c.point, plan.settings.mode, via);
      const navLinks = isApple()
        ? `<a class="btn btn-small" data-testid="stop-nav" href="${appleMapsUrl(c.point, plan.settings.mode, via)}" target="_blank" rel="noopener">Apple Karten</a>
           <a class="btn btn-small" data-testid="stop-nav-google" href="${google}" target="_blank" rel="noopener">Google Maps</a>`
        : `<a class="btn btn-small" data-testid="stop-nav" href="${google}" target="_blank" rel="noopener">Navigation</a>`;
      return `
        <li class="stop" data-testid="stop">
          <span class="stop-num" aria-hidden="true">${i + 1}</span>
          <div class="stop-main">
            <div class="stop-title">${esc(title)}${stop.tight ? ' <span class="badge-tight">wird knapp</span>' : ''}</div>
            <div class="stop-way">${esc(way)}</div>
            ${stop.route.crosses ? '<div class="stop-cross" data-testid="stop-cross">⚠ Weg quert die Strecke – ohne Queren gibt es hier keinen Weg. Nur queren, wenn gerade niemand kommt bzw. Ordner es erlauben.</div>' : ''}
            <div class="stop-arrive" data-testid="stop-arrive">Los ${clock(leave)}${i === 0 ? ` (${esc(relative(leave, now))})` : ''} · an ca. ${clock(stop.arrive)}</div>
            ${j ? journeyHtml(j) : ''}
            <ul class="stop-athletes">${times}</ul>
            ${via.length ? `<p class="stop-via">Navi führt über ${via.length} Zwischenziel${via.length > 1 ? 'e' : ''} auf diesem Weg.</p>` : ''}
            <div class="stop-actions">
              <button type="button" class="btn btn-small" data-show-stop="${i}">Weg zeigen</button>
              ${navLinks}
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
      ${
        plan.estimated
          ? `<p class="hint" data-testid="plan-estimated">${
              plan.settings.mode === 'oepnv'
                ? 'Fahrplan gerade nicht erreichbar: Zeiten nur geschätzt. Prüfe die Verbindung vor der Abfahrt in der Navi-App.'
                : 'Wege nur geschätzt: Das Routing ist gerade nicht erreichbar.'
            }</p>`
          : ''
      }
      <ol class="stops">${items}</ol>
      ${plan.settings.mode === 'oepnv' ? ticketHtml(plan, new Date(plan.startTime)) : ''}
      <button class="btn btn-quiet" id="btn-plan-clear" type="button">Plan verwerfen</button>
    </div>`;
}

/** Fahrten einer Verbindung: „Bus 5009 · 10:16 Rotes Tor → 10:27 Sportplatz“. */
function journeyHtml(j: Journey): string {
  const rides = rideLegs(j)
    .map(
      (l) =>
        `<li><strong>${esc(legLabel(l))}</strong> ${clock(l.from.time)} ${esc(l.from.name)} → ${clock(l.to.time)} ${esc(l.to.name)}</li>`,
    )
    .join('');
  return rides ? `<ol class="stop-legs" data-testid="stop-legs">${rides}</ol>` : '';
}

/** Ticket-Tipp für die Gruppe unter dem Plan. */
function ticketHtml(plan: Plan, day: Date): string {
  const journeys = plan.stops.flatMap((s) => (s.journey ? [s.journey] : []));
  const people = plan.settings.people ?? 1;
  const tip = suggestTicket(journeys, people, day);
  const who = people === 1 ? 'dich' : `${people} Personen`;
  // Fahrplan war nicht erreichbar → kein Tipp statt eines falschen „kein Ticket nötig“
  if (plan.estimated && !journeys.length) return '';
  let body: string;
  if (tip.none) body = 'Kein Ticket nötig – alle Wege gehen zu Fuß.';
  else {
    const parts: string[] = [];
    if (tip.land) {
      const n = tip.land.tickets > 1 ? `${tip.land.tickets}× ` : '';
      parts.push(
        `Für ${who}: <strong>${n}${esc(tip.land.name)}</strong> für zusammen ca. ${euro(tip.land.price)} (DB-Preis, Stand ${TICKET_PRICES_AS_OF}).${tip.land.note ? ` ${esc(tip.land.note)}` : ''} <a href="${LAENDER_URL}" target="_blank" rel="noopener">Länder-Tickets</a>`,
      );
    } else if (tip.uncovered?.length) {
      parts.push(`Für diese Fahrten (${esc(tip.uncovered.join(', '))}) kenne ich kein passendes Länder-Ticket – Ticket bitte in der Navi- oder Verbund-App prüfen.`);
    }
    if (tip.verbund) {
      parts.push(
        `Fahrt ihr nur im ${esc(tip.verbund.name)}-Gebiet? Dann prüft auch die <a href="${tip.verbund.url}" target="_blank" rel="noopener">${esc(tip.verbund.ticket)}</a> – oft günstiger.`,
      );
    }
    body = parts.join(' ');
  }
  return `<div class="ticket-tip" data-testid="ticket-tip"><strong class="ticket-title">Ticket-Tipp</strong> ${body}</div>
    ${journeys.length ? '<p class="hint attribution">Fahrplandaten: <a href="https://transitous.org" target="_blank" rel="noopener">Transitous</a></p>' : ''}`;
}
