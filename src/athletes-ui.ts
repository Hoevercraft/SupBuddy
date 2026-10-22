import { nearestOnCourse } from './course';
import { clock, isoDate, mmss, parseMmss, relative } from './format';
import { formatKm } from './geo';
import {
  ATHLETE_COLORS,
  DEFAULT_PACE,
  DEFAULT_TRANSITION,
  DISCIPLINES,
  type Athlete,
  type Discipline,
  type Point,
  type RaceEvent,
} from './model';
import { planAt, timeAtAlong, timeline, type PlanState } from './schedule';
import type { Sighting, SyncState } from './sightings';
import type { LiveView } from './live';
import { liveLine } from './live-ui';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const km = (m: number) => formatKm(m).replace(' km', '');

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

/** Disziplinen, für die ein Tempo gebraucht wird. */
function disciplinesIn(ev: RaceEvent): Set<Discipline> {
  return new Set(ev.legs.map((l) => l.discipline));
}

function needsTransition(ev: RaceEvent): boolean {
  const d = disciplinesIn(ev);
  if (d.has('wechsel')) return true;
  return ev.legs.some((l, i) => i > 0 && l.discipline !== ev.legs[i - 1].discipline);
}

// ---------------------------------------------------------------- Status-Texte

/** Woher die Angabe kommt. */
export type Basis = 'plan' | 'sighting' | 'live' | 'live-stale';
const BASIS: Record<Basis, string> = { plan: 'Laut Plan', sighting: 'Nach Sichtung', live: 'Live', 'live-stale': 'Geschätzt' };

/** Live-Daten bzw. Sichtung: was ist der Anker für den Zeitplan? */
export function basisOf(lv: LiveView | undefined, seen: Sighting | undefined): Basis {
  const fix = lv?.fix;
  if (fix && (!seen || seen.seenAt <= fix.at)) return lv!.fresh ? 'live' : 'live-stale';
  return seen ? 'sighting' : 'plan';
}

/** Startzeit vorbei, aber Live-Daten zeigen ihn noch am Start (z. B. Wellenstart). */
function waitingAtStart(lv: LiveView | undefined, seen: Sighting | undefined, plan: PlanState): boolean {
  return !!lv?.fresh && !!lv.fix?.waiting && (!seen || seen.seenAt <= lv.fix.at) && plan.state === 'unterwegs';
}

function statusText(ev: RaceEvent, plan: PlanState, now: number, basisKind: Basis = 'plan'): string {
  const basis = BASIS[basisKind];
  switch (plan.state) {
    case 'vor-start': {
      const sameDay = isoDate(new Date(plan.start)) === isoDate(new Date(now));
      const when = sameDay
        ? `um ${clock(plan.start)}`
        : `am ${new Date(plan.start).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })} um ${clock(plan.start)}`;
      return `Start ${when} · ${relative(plan.start, now)}`;
    }
    case 'im-ziel':
      return `${basis} im Ziel seit ${clock(plan.finish)}`;
    case 'unterwegs': {
      const leg = ev.legs[plan.legIndex];
      if (plan.inTransition) return `${basis} im Wechsel nach ${DISCIPLINES[leg.discipline].label}`;
      const multi = ev.legs.length > 1 ? ` (${DISCIPLINES[leg.discipline].label})` : '';
      return `${basis} bei km ${km(plan.along)}${multi}`;
    }
  }
}

function hereText(ev: RaceEvent, athlete: Athlete, position: Point, now: number, today: Date): string {
  const n = nearestOnCourse(ev, position);
  if (!n) return '';
  const t = timeAtAlong(timeline(ev, athlete, today), n.along);
  const where = n.distance < 30 ? `Bei dir (km ${km(n.along)})` : `An deinem nächsten Streckenpunkt (km ${km(n.along)})`;
  // Geschützte Leerzeichen: „ca. 10:19“ und „in 9 min“ nicht auseinanderreißen
  const nb = (x: string) => x.replace(/ /g, '\u00a0');
  return t >= now - 60_000
    ? `${where}: ${nb(`ca. ${clock(t)}`)} · ${nb(relative(t, now))}`
    : `${where}: schon vorbei, ${nb(`ca. ${clock(t)}`)}`;
}

/** Kurzstatus für die Leiste unten: „km 12,3 · bei dir in 20 min“. */
export function shortStatus(ev: RaceEvent, athlete: Athlete, plan: PlanState, position: Point | null, now: number, seenAt?: number, lv?: LiveView): string {
  const s = shortStatusPlain(ev, athlete, plan, position, now);
  // Woher die Zeit kommt: Live-Tracking, Sichtung oder nur der Plan
  if (lv?.fix && (seenAt === undefined || seenAt <= lv.fix.at)) {
    if (lv.fresh && lv.fix.waiting && plan.state === 'unterwegs') return 'wartet am Start · live';
    return lv.fresh ? `${s} · live` : `${s} · zuletzt live ${clock(lv.fix.at)}`;
  }
  return seenAt === undefined ? s : `${s} · gesichtet ${clock(seenAt)}`;
}

function shortStatusPlain(ev: RaceEvent, athlete: Athlete, plan: PlanState, position: Point | null, now: number): string {
  const nb = (x: string) => x.replace(/ /g, '\u00a0');
  let here = '';
  if (position && plan.state !== 'im-ziel') {
    const n = nearestOnCourse(ev, position);
    if (n) {
      const t = timeAtAlong(timeline(ev, athlete, new Date(now)), n.along);
      here = t >= now - 60_000 ? `bei dir ${nb(relative(t, now))}` : 'an dir vorbei';
    }
  }
  switch (plan.state) {
    case 'vor-start':
      return [`Start ${nb(relative(plan.start, now))}`, here].filter(Boolean).join(' · ');
    case 'im-ziel':
      return 'im Ziel';
    case 'unterwegs':
      return [plan.inTransition ? 'im Wechsel' : `km ${km(plan.along)}`, here].filter(Boolean).join(' · ');
  }
}

export interface AthleteNow {
  athlete: Athlete;
  plan: PlanState;
}

export function athletesNow(ev: RaceEvent, now: number): AthleteNow[] {
  const today = new Date(now);
  return ev.athletes.map((athlete) => ({ athlete, plan: planAt(ev, timeline(ev, athlete, today), now) }));
}

export interface SightingView {
  /** jüngste Sichtung je Athlet */
  latest: Map<string, Sighting>;
  /** eigener Standort liegt an der Strecke → „Jetzt hier“ möglich */
  atCourse: boolean;
  sync: SyncState;
  /** Live-Tracking je Athleten-Kennung */
  live?: Map<string, LiveView>;
}

function sightingLine(s: Sighting): string {
  const who = s.mine
    ? ` · von dir${s.pending ? ', wird übertragen …' : ''} <button type="button" class="link-btn" data-unsight="${esc(s.id)}">zurücknehmen</button>`
    : '';
  return `<div class="athlete-sighting" data-testid="athlete-sighting">Gesichtet um ${clock(s.seenAt)} bei km ${km(s.along)}${who}</div>`;
}

export function athletesSection(ev: RaceEvent, position: Point | null, now: number, sv?: SightingView): string {
  const today = new Date(now);
  const rows = athletesNow(ev, now)
    .map(({ athlete, plan }, i) => {
      const here = position ? hereText(ev, athlete, position, now, today) : '';
      const seen = athlete.id ? sv?.latest.get(athlete.id) : undefined;
      const lv = athlete.id ? sv?.live?.get(athlete.id) : undefined;
      const live = lv ? liveLine(lv, now) : '';
      // Frische Live-Daten: Sichten unnötig
      const sightBtn =
        sv?.atCourse && plan.state !== 'im-ziel' && !lv?.active
          ? `<button type="button" class="btn btn-small sight-btn" data-sight="${i}">${esc(athlete.name)} jetzt hier</button>`
          : '';
      return `
      <li class="athlete" style="--athlete-color:${athlete.color}" data-testid="athlete">
        <span class="athlete-dot" aria-hidden="true">${esc(initials(athlete.name))}</span>
        <div class="athlete-main">
          <div class="athlete-name">${esc(athlete.name)}</div>
          <div class="athlete-status" data-testid="athlete-status">${esc(waitingAtStart(lv, seen, plan) ? 'Live: wartet am Start' : statusText(ev, plan, now, basisOf(lv, seen)))}</div>
          ${live ? `<div class="athlete-live${lv?.fresh ? ' is-fresh' : ''}" data-testid="athlete-live">${esc(live)}</div>` : ''}
          ${seen ? sightingLine(seen) : ''}
          ${here ? `<div class="athlete-here" data-testid="athlete-here">${esc(here)}</div>` : ''}
          ${sightBtn}
        </div>
        <button class="athlete-edit" type="button" data-index="${i}" aria-label="${esc(athlete.name)} bearbeiten">Ändern</button>
      </li>`;
    })
    .join('');

  const date = ev.date ?? isoDate(today);
  return `
    <section class="athletes" aria-label="Athleten">
      <div class="athletes-head">
        <h3>Athleten</h3>
        <label class="race-day">Renntag <input type="date" id="race-date" value="${date}" /></label>
      </div>
      ${
        rows
          ? `<ul class="athlete-list">${rows}</ul>`
          : `<p class="hint">Trag ein, wer startet, wann und wie schnell. Dann siehst du, wo er laut Plan gerade ist und wann er bei dir vorbeikommt.</p>`
      }
      <button class="btn" id="btn-add-athlete" type="button">Athlet hinzufügen</button>
      ${rows && sv ? sightingHint(sv, !!position) : ''}
    </section>`;
}

function sightingHint(sv: SightingView, hasPosition: boolean): string {
  const how = sv.atCourse
    ? 'Kommt jemand vorbei, tippe „… jetzt hier“ – der Zeitplan rechnet dann mit der echten Zeit weiter.'
    : hasPosition
      ? '„Jetzt hier“ geht, sobald du an der Strecke stehst (bis 150 m).'
      : 'Mit deinem Standort kannst du an der Strecke melden, wenn jemand vorbeikommt.';
  const sync =
    sv.sync === 'expired'
      ? ' <strong>Event abgelaufen:</strong> Sichtungen werden nicht mehr geteilt.'
      : sv.sync === 'offline'
        ? ' <strong>Gerade offline:</strong> Sichtungen bleiben auf diesem Handy und werden nachgereicht.'
        : ' Sichtungen sehen alle, die euren Link haben.';
  return `<p class="hint sight-hint" data-testid="sight-hint">${how}${sync}</p>`;
}

// ---------------------------------------------------------------- Dialog

export function athleteDialogHtml(): string {
  return `
    <dialog class="share athlete-dialog" id="athlete-dialog">
      <form id="athlete-form" novalidate>
        <h2 id="athlete-title">Athlet hinzufügen</h2>
        <label class="field">
          <span>Name</span>
          <input name="name" aria-label="Name des Athleten" maxlength="40" autocomplete="off" />
        </label>
        <label class="field">
          <span>Startzeit</span>
          <input name="start" type="time" aria-label="Startzeit" />
        </label>
        <label class="field" data-discipline="schwimmen">
          <span>Schwimmen</span>
          <span class="with-unit"><input name="schwimmen" inputmode="decimal" aria-label="Schwimm-Pace in min pro 100 m" placeholder="2:00" /> min/100 m</span>
        </label>
        <label class="field" data-discipline="rad">
          <span>Rad</span>
          <span class="with-unit"><input name="rad" inputmode="decimal" aria-label="Rad-Tempo in km/h" placeholder="30" /> km/h</span>
        </label>
        <label class="field" data-discipline="lauf">
          <span>Lauf</span>
          <span class="with-unit"><input name="lauf" inputmode="decimal" aria-label="Lauf-Pace in min pro km" placeholder="5:30" /> min/km</span>
        </label>
        <label class="field" data-discipline="wechsel">
          <span>Wechsel</span>
          <span class="with-unit"><input name="transition" inputmode="decimal" aria-label="Wechselzeit in Minuten" placeholder="3" /> min je Wechsel</span>
        </label>
        <p class="hint" id="pace-live-note" data-testid="pace-live-note" hidden>Tempo kommt gerade aus dem Live-Tracking.</p>
        <p class="form-error" id="athlete-error" role="alert" hidden></p>
        <div class="actions">
          <button class="btn btn-primary" type="submit">Speichern</button>
          <button class="btn" type="button" id="athlete-cancel">Abbrechen</button>
        </div>
        <section class="live-setup" id="live-setup" data-testid="live-setup"></section>
        <button class="btn btn-quiet btn-danger" type="button" id="athlete-delete" hidden>Athlet entfernen</button>
      </form>
    </dialog>`;
}

/** Füllt und öffnet den Dialog. index = null → neuer Athlet. liveActive = Tempo kommt aus dem Live-Tracking. */
export function openAthleteDialog(dialog: HTMLDialogElement, ev: RaceEvent, index: number | null, liveActive = false): void {
  const form = dialog.querySelector<HTMLFormElement>('#athlete-form')!;
  const a = index != null ? ev.athletes[index] : null;
  const template = a ?? ev.athletes[ev.athletes.length - 1];
  const used = new Set(ev.athletes.map((x) => x.color));

  dialog.dataset.index = index == null ? '' : String(index);
  dialog.dataset.color = a?.color ?? ATHLETE_COLORS.find((c) => !used.has(c)) ?? ATHLETE_COLORS[ev.athletes.length % ATHLETE_COLORS.length];
  dialog.querySelector('#athlete-title')!.textContent = a ? `${a.name} bearbeiten` : 'Athlet hinzufügen';
  (dialog.querySelector('#athlete-delete') as HTMLElement).hidden = !a;
  (dialog.querySelector('#athlete-error') as HTMLElement).hidden = true;

  const pace = template?.pace ?? DEFAULT_PACE;
  const set = (name: string, value: string) => ((form.elements.namedItem(name) as HTMLInputElement).value = value);
  set('name', a?.name ?? '');
  set('start', a?.start ?? template?.start ?? '09:00');
  set('schwimmen', mmss(pace.schwimmen));
  set('rad', String(pace.rad).replace('.', ','));
  set('lauf', mmss(pace.lauf));
  set('transition', String((template?.transition ?? DEFAULT_TRANSITION) / 60).replace('.', ','));

  const present = disciplinesIn(ev);
  for (const el of Array.from(form.querySelectorAll<HTMLElement>('[data-discipline]'))) {
    const d = el.dataset.discipline as Discipline;
    // Mit frischen Live-Daten braucht es kein geschätztes Tempo (Werte bleiben gespeichert)
    el.hidden = d === 'wechsel' ? !needsTransition(ev) : !present.has(d) || liveActive;
  }
  (dialog.querySelector('#pace-live-note') as HTMLElement).hidden = !liveActive;
  dialog.showModal();
  if (!a) (form.elements.namedItem('name') as HTMLInputElement).focus();
}

/** Liest den Dialog aus. Gibt den Athleten oder eine Fehlermeldung zurück. */
export function readAthleteForm(dialog: HTMLDialogElement): Athlete | string {
  const form = dialog.querySelector<HTMLFormElement>('#athlete-form')!;
  const val = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
  const visible = (d: string) => !(form.querySelector(`[data-discipline="${d}"]`) as HTMLElement).hidden;

  const name = val('name');
  if (!name) return 'Gib einen Namen ein.';
  const start = val('start');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return 'Gib eine Startzeit ein, z. B. 09:00.';

  const swim = parseMmss(val('schwimmen'));
  if (visible('schwimmen') && (swim == null || swim < 50 || swim > 300))
    return 'Schwimm-Pace bitte als Minuten pro 100 m, z. B. 2:00.';
  const rad = Number(val('rad').replace(',', '.'));
  if (visible('rad') && !(rad >= 5 && rad <= 80)) return 'Rad-Tempo bitte in km/h, z. B. 30.';
  const lauf = parseMmss(val('lauf'));
  if (visible('lauf') && (lauf == null || lauf < 120 || lauf > 900))
    return 'Lauf-Pace bitte als Minuten pro km, z. B. 5:30.';
  const wechsel = Number(val('transition').replace(',', '.'));
  if (visible('wechsel') && !(wechsel >= 0 && wechsel <= 60)) return 'Wechselzeit bitte in Minuten, z. B. 3.';

  return {
    name,
    color: dialog.dataset.color ?? ATHLETE_COLORS[0],
    start,
    pace: {
      schwimmen: swim ?? DEFAULT_PACE.schwimmen,
      rad: Number.isFinite(rad) && rad > 0 ? rad : DEFAULT_PACE.rad,
      lauf: lauf ?? DEFAULT_PACE.lauf,
    },
    transition: Number.isFinite(wechsel) && wechsel >= 0 ? Math.round(wechsel * 60) : DEFAULT_TRANSITION,
  };
}
