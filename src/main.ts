import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/800.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { athleteDialogHtml, athletesNow, athletesSection, initials, openAthleteDialog, readAthleteForm, shortStatus } from './athletes-ui';
import { courseStats, legDistance, nearestOnCourse, type CourseNearest } from './course';
import { DETOUR, MODES, type Mode } from './cheer';
import { isoDate } from './format';
import { buildPlan, type Plan, type PlanSettings } from './plan';
import { loadSettings, planSection, saveSettings } from './plan-ui';
import { estimatedRoute, fetchRoute, type Route } from './routing';
import { estimateTransitSeconds, fetchJourneys, type Journey } from './transit';
import { journeyRoute } from './plan';
import { pickHtml } from './pick-ui';
import { formatDistance, formatKm, haversine } from './geo';
import { GpxError, parseGpx } from './gpx';
import { DISCIPLINES, eventKind, type Discipline, type Point, type RaceEvent } from './model';
import { decodeEvent, normalizeLeg, shareUrl, tokenFromHash } from './share';
import { loadEvent, loadLastLink, saveEvent, saveLastLink } from './store';
import { adoptIds, randomId, withIds } from './ids';
import { EventSync, isShared } from './eventsync';
import { setSightingOffsets } from './schedule';
import { alongsNear, latestByAthlete, offsetsFrom, sightingAlong, SightingStore } from './sightings';

export const APP_VERSION = __APP_VERSION__;
/** Zum Troubleshooting: ändert sich mit jedem Deploy. */
export const BUILD_LABEL = `v${__APP_VERSION__} · ${__APP_COMMIT__} · ${__APP_BUILD_TIME__}`;

// ---------------------------------------------------------------- Zustand

let event: RaceEvent | null = null;
let position: Point | null = null;
let mapOnly = false;
/** Geöffneter Bereich (Icons rechts); null = nur Karte + Leiste unten */
export type Section = 'athleten' | 'plan' | 'strecke';
let section: Section | null = null;
const SECTION_TITLES: Record<Section, string> = { athleten: 'Athleten', plan: 'Anfeuer-Plan', strecke: 'Strecke' };
let plan: Plan | null = null;
let planBusy = false;
let planSettings: PlanSettings | null = null;
let courseMap: import('./map').CourseMap | null = null;
/** Angetippter Streckenpunkt (Karte am Punkt) */
let pick: { n: CourseNearest; route: Route | null; journey?: Journey; arrive: number | null; busy: boolean; locating: boolean; anchor: 'top' | 'bottom' } | null = null;
const pickEl = document.createElement('div');
/** Sichtungen des aktuellen Events (geteilt über Supabase) */
const sightings = new SightingStore(onSightingsChange);
let lastOffsets = new Map<string, number>();
/** Ganzes Event live für alle mit dem Link (Stufe 5b) */
const eventSync = new EventSync(applyRemoteEvent, () => {
  renderStatus();
  if (section === 'strecke') renderSheetUnlessTyping();
});
/** Panel wurde für die Punkt-Karte eingeklappt (kleiner Bildschirm) → beim Schließen wieder zeigen */
let pickHidSection: Section | null = null;

// ---------------------------------------------------------------- Hilfen

const $ = <T extends HTMLElement>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} fehlt`);
  return el;
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let toastTimer: number | undefined;
function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : 3000);
}

function hm(m: number): string {
  return `${Math.round(m).toLocaleString('de-DE')} Hm`;
}

// ---------------------------------------------------------------- Gerüst

function shell(root: HTMLElement): void {
  root.innerHTML = `
    <div id="map" class="map" aria-label="Karte"></div>

    <header class="bib" id="bib" hidden>
      <input class="bib-name" id="event-name" aria-label="Name des Rennens" maxlength="60" />
      <div class="bib-row">
        <span class="bib-kind" id="event-kind"></span>
        <span class="bib-stats">
          <strong data-testid="total-distance" id="total-distance"></strong>
          <span id="total-gain"></span>
        </span>
      </div>
    </header>

    <button class="statusbar" id="statusbar" type="button" data-testid="statusbar" hidden></button>
    <section class="sheet" id="sheet" aria-live="polite"></section>

    <input type="file" id="file-input" accept=".gpx,application/gpx+xml,application/xml,text/xml" multiple hidden />

    <dialog class="share" id="share-dialog">
      <form method="dialog">
        <h2>Strecke teilen</h2>
        <p>Wer den Link öffnet, sieht genau diese Strecke. Er funktioniert ohne Anmeldung.</p>
        <input id="share-link" data-testid="share-link" readonly aria-label="Link zum Teilen" />
        <div class="actions">
          <button type="button" class="btn btn-primary" id="share-copy">Link kopieren</button>
          <button type="button" class="btn" id="share-native" hidden>Teilen …</button>
          <button class="btn btn-quiet" value="close">Schließen</button>
        </div>
      </form>
    </dialog>

    ${athleteDialogHtml()}

    <div class="toast" id="toast" role="status" hidden></div>
    <small class="version" data-testid="version">${BUILD_LABEL}</small>
  `;
}

// ---------------------------------------------------------------- Darstellung

function renderBib(): void {
  const bib = $('#bib');
  if (!event) {
    bib.hidden = true;
    return;
  }
  bib.hidden = false;
  const stats = courseStats(event);
  const nameInput = $<HTMLInputElement>('#event-name');
  if (document.activeElement !== nameInput) nameInput.value = event.name;
  $('#event-kind').textContent = eventKind(event);
  $('#total-distance').textContent = formatKm(stats.distance);
  $('#total-gain').textContent = stats.elevationGain != null ? `↑ ${hm(stats.elevationGain)}` : '';
}

function positionText(): string {
  if (!event) return '';
  if (!position) {
    return `<p class="where">Zeig deinen Standort, dann siehst du, wie weit du von der Strecke weg bist.</p>
      <button class="btn" id="btn-locate" type="button">Standort anzeigen</button>`;
  }
  const n = nearestOnCourse(event, position);
  if (!n) return '';
  const leg = event.legs[n.legIndex];
  const legInfo = event.legs.length > 1 ? ` (${esc(DISCIPLINES[leg.discipline].label)}, km ${formatKm(n.alongLeg).replace(' km', '')})` : '';
  if (n.distance < 30) {
    return `<p class="where" data-testid="where">Du stehst an der Strecke, bei <strong>km ${formatKm(n.along).replace(' km', '')}</strong>${legInfo}.</p>`;
  }
  return `<p class="where" data-testid="where">Du bist <strong>${formatDistance(n.distance)}</strong> von der Strecke entfernt, auf Höhe von km ${formatKm(n.along).replace(' km', '')}${legInfo}.</p>`;
}

/** Leiste unten: wo sind die Athleten, wann bei mir. Tippen öffnet „Athleten“. */
function renderStatus(): void {
  const bar = $('#statusbar');
  bar.hidden = !event || section !== null;
  if (!event) return;
  const now = Date.now();
  const items = athletesNow(event, now);
  const seen = latestByAthlete(sightings.list);
  bar.setAttribute('aria-label', 'Athleten öffnen');
  bar.innerHTML = items.length
    ? `<ul class="status-list">${items
        .slice(0, 3)
        .map(
          ({ athlete, plan: p }) =>
            `<li style="--athlete-color:${athlete.color}"><span class="status-dot" aria-hidden="true">${esc(initials(athlete.name))}</span><span class="status-name">${esc(athlete.name)}</span> <span class="status-text">${esc(shortStatus(event!, athlete, p, position, now, athlete.id ? seen.get(athlete.id)?.seenAt : undefined))}</span></li>`,
        )
        .join('')}${items.length > 3 ? `<li class="status-more">+${items.length - 3} weitere</li>` : ''}</ul>`
    : '<span class="status-empty">Noch keine Athleten – hier tippen zum Eintragen</span>';
  // Nicht übersehen: Änderungen kommen gerade nicht bei den anderen an
  if (eventSync.state === 'expired') {
    bar.insertAdjacentHTML('beforeend', '<p class="status-note" data-testid="expired-note">Event abgelaufen – Änderungen werden nicht mehr geteilt.</p>');
  } else if (eventSync.state === 'offline' || sightings.state === 'offline') {
    bar.insertAdjacentHTML('beforeend', '<p class="status-warn" data-testid="sync-warn">⚠ Nicht synchron – Änderungen werden nachgereicht, sobald es wieder geht.</p>');
  }
}

/** Bereich öffnen/schließen (null = alle zu). */
function setSection(s: Section | null): void {
  section = event ? s : null;
  if (section === 'athleten') void sightings.refresh();
  if (section && mapOnly) setMapOnly(false);
  document.body.dataset.section = section ?? '';
  courseMap?.setSection(section);
  renderSheet();
  renderStatus();
  $('#sheet').scrollTop = 0;
}

function renderSheet(): void {
  const sheet = $('#sheet');
  sheet.hidden = !!event && !section;
  if (!event) {
    sheet.innerHTML = `
      <h2 class="sheet-title">Welches Rennen schaust du?</h2>
      <p>Lade die Strecke als GPX-Datei. Beim Triathlon lädst du eine Datei pro Disziplin oder eine Datei mit allen Etappen.</p>
      <button class="btn btn-primary btn-wide" id="btn-load" type="button">GPX-Datei laden</button>
      <p class="hint">Du hast einen SupBuddy-Link bekommen? Öffne ihn einfach, die Strecke ist dann schon drin.</p>
    `;
    return;
  }

  const options = (sel: Discipline) =>
    (Object.keys(DISCIPLINES) as Discipline[])
      .map((d) => `<option value="${d}"${d === sel ? ' selected' : ''}>${DISCIPLINES[d].label}</option>`)
      .join('');

  const legs = event.legs
    .map(
      (leg, i) => `
      <li class="leg" style="--leg-color:${DISCIPLINES[leg.discipline].color}" data-testid="leg">
        <span class="leg-bar" aria-hidden="true"></span>
        <span class="leg-name">${esc(leg.name)}</span>
        <select class="leg-discipline" data-index="${i}" aria-label="Disziplin von ${esc(leg.name)}">${options(leg.discipline)}</select>
        <span class="leg-km">${formatKm(legDistance(leg))}</span>
        <button class="leg-remove" type="button" data-index="${i}" aria-label="${esc(leg.name)} entfernen">×</button>
      </li>`,
    )
    .join('');

  if (!section) {
    sheet.innerHTML = '';
    return;
  }
  const body =
    section === 'athleten'
      ? `${positionText()}${athletesSection(event, position, Date.now(), {
          latest: latestByAthlete(sightings.list),
          atCourse: !!position && alongsNear(event, position).length > 0,
          sync: sightings.state,
        })}`
      : section === 'plan'
        ? `${planSection(event, { settings: currentPlanSettings(), plan, busy: planBusy, fromPosition: !!position, now: Date.now() })}
           <p class="hint pick-tip" data-testid="pick-tip">Tipp: Tippe auf die Strecke – du siehst, wann deine Athleten dort sind, und den Weg dorthin.</p>`
        : `<ul class="legs">${legs}</ul>
           <div class="actions">
             <button class="btn btn-primary" id="btn-share" type="button">Link teilen</button>
             <button class="btn" id="btn-load" type="button">Etappe hinzufügen</button>
           </div>
           <p class="hint live-hint" data-testid="live-hint">${liveHint()}</p>
           <button class="btn btn-quiet" id="btn-reset" type="button">Anderes Rennen laden</button>`;
  sheet.innerHTML = `
    <div class="section-head">
      <span class="sheet-grip" aria-hidden="true"></span>
      <h2 class="section-title" data-testid="section-title">${SECTION_TITLES[section]}</h2>
      <button class="section-close" type="button" data-close-section aria-label="${SECTION_TITLES[section]} schließen">×</button>
    </div>
    <div class="section-body section-${section}">${body}</div>
  `;
}

/** Frei sichtbarer Kartenbereich: oben die Startnummer, unten das Panel (außer im Vollbild). */
function visiblePadding() {
  const vh = window.innerHeight;
  const bib = document.querySelector('#bib');
  const sheet = document.querySelector('#sheet');
  const bibBox = bib && !mapOnly && !(bib as HTMLElement).hidden ? bib.getBoundingClientRect() : null;
  // Offenes Panel – sonst die schmale Leiste unten
  const bar = document.querySelector<HTMLElement>('#statusbar');
  const lower = sheet && !(sheet as HTMLElement).hidden ? sheet : bar && !bar.hidden ? bar : null;
  const sheetBox = lower && !mapOnly ? lower.getBoundingClientRect() : null;
  // Panel unten über die volle Breite → unten abziehen; auf breiten Bildschirmen liegt es links
  const sheetBottom = sheetBox && sheetBox.width > window.innerWidth * 0.9;
  return {
    top: (bibBox ? bibBox.bottom : 0) + 30,
    bottom: (sheetBottom ? vh - sheetBox!.top : 0) + 30,
    left: (sheetBox && !sheetBottom ? sheetBox.right : 0) + 44,
    right: 70, // Kartenknöpfe rechts
  };
}

/** Vollbild-Karte: Startnummer und Panel ausblenden. */
function setMapOnly(on: boolean): void {
  mapOnly = on && !!event;
  document.body.classList.toggle('map-only', mapOnly);
  courseMap?.setMapOnly(mapOnly);
}

/** Athleten-Marker an ihre Plan-Position setzen. */
function renderAthleteMarkers(): void {
  const items = event
    ? athletesNow(event, Date.now()).map(({ athlete, plan }) => ({
        label: initials(athlete.name),
        name: athlete.name,
        color: athlete.color,
        point: plan.state === 'unterwegs' ? plan.point : null,
      }))
    : [];
  courseMap?.setAthletes(items);
}

function render(fit = false): void {
  document.body.classList.toggle('has-event', !!event);
  if (!event && mapOnly) setMapOnly(false);
  document.body.dataset.section = section ?? '';
  courseMap?.setSection(section);
  renderBib();
  renderSheet();
  renderStatus();
  courseMap?.setEvent(event, fit);
  renderAthleteMarkers();
}

/** Hinweis im Bereich Strecke: geteilt? bis wann? */
function liveHint(): string {
  if (!event?.id || !isShared(event.id)) {
    return 'Mit „Link teilen“ seht ihr ab dann alle denselben Stand – Änderungen kommen bei allen an.';
  }
  if (eventSync.state === 'expired') {
    return '<strong>Abgelaufen:</strong> Der Server hat dieses Event gelöscht (2 Tage nach dem Renntag bzw. 7 Tage ohne Änderung). Auf diesem Handy bleibt alles, geteilt wird nichts mehr.';
  }
  if (eventSync.state === 'offline') return '<strong>Gerade offline:</strong> Änderungen werden übertragen, sobald wieder Netz da ist.';
  const until = eventSync.expiresAt
    ? ` bis ${new Date(eventSync.expiresAt - 1).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })} – danach löscht der Server die Daten (2 Tage nach dem Renntag, ohne Renntag 7 Tage nach der letzten Änderung)`
    : '';
  return `Live geteilt${until}. Änderungen an Strecke, Athleten und Renntag sehen alle, die euren Link haben.`;
}

/** Neuigkeiten (Antwort auf einen eigenen Tipp, Abgleich) gleich zeigen – außer jemand tippt gerade. */
function renderSheetUnlessTyping(): void {
  const a = document.activeElement;
  const typing = (a instanceof HTMLInputElement || a instanceof HTMLSelectElement) && $('#sheet').contains(a);
  if (!typing && !$<HTMLDialogElement>('#athlete-dialog').open) renderSheet();
}

/** Plan-Positionen laufen mit der Uhr: regelmäßig auffrischen, ohne laufende Eingaben zu stören. */
/** Letzte Berührung/Scrollen im Panel – solange jemand dort arbeitet, nicht neu aufbauen. */
let lastSheetInteraction = 0;
const SHEET_QUIET_MS = 8000;

function sheetBusy(): boolean {
  const sheet = $('#sheet');
  const focused = sheet.contains(document.activeElement) && document.activeElement !== document.body;
  return focused || Date.now() - lastSheetInteraction < SHEET_QUIET_MS || $<HTMLDialogElement>('#athlete-dialog').open;
}

function tick(): void {
  if (!event || event.athletes.length === 0) return;
  renderAthleteMarkers();
  renderStatus();
  if (!sheetBusy()) renderSheet();
}

function currentPlanSettings(): PlanSettings {
  if (!event) throw new Error('kein Event');
  if (!planSettings || planSettings.athleteIndex >= event.athletes.length) planSettings = loadSettings(event);
  return planSettings;
}

function updatePlanSettings(patch: Partial<PlanSettings>): void {
  planSettings = { ...currentPlanSettings(), ...patch };
  saveSettings(planSettings);
}

function clearPlan(): void {
  plan = null;
  courseMap?.setPlan([], []);
}

async function createPlan(): Promise<void> {
  if (!event || planBusy) return;
  const ev = event;
  const settings = currentPlanSettings();
  const start = position ?? ev.legs[0].points[0];
  planBusy = true;
  renderSheet();
  try {
    plan = await buildPlan(ev, settings, start, Date.now(), (a, b) => fetchRoute(ev, a, b, settings.mode === 'oepnv' ? 'fuss' : settings.mode), fetchJourneys);
    courseMap?.setPlan(
      plan.stops.map((s) => ({ point: s.candidate.point })),
      plan.stops.map((s) => s.route.points),
    );
    const pts = plan.stops.flatMap((s) => s.route.points);
    if (pts.length) courseMap?.fitPoints([start, ...pts]);
  } finally {
    planBusy = false;
    renderSheet();
    document.body.dataset.planned = String(Date.now());
  }
}

// ---------------------------------------------------------------- Punkt antippen

function renderPick(): void {
  if (!event || !pick || !courseMap) return;
  const s = currentPlanSettings();
  pickEl.innerHTML = pickHtml(event, {
    n: pick.n,
    mode: s.mode,
    speed: s.speed,
    athleteIndex: s.athleteIndex,
    route: pick.route,
    journey: pick.journey,
    arrive: pick.arrive,
    busy: pick.busy,
    locating: pick.locating,
    hasPosition: !!position,
    now: Date.now(),
  });
  courseMap.showPick(pick.n.point, pickEl, pick.anchor);
}

function openPick(n: CourseNearest): void {
  pick = { n, route: null, arrive: null, busy: false, locating: false, anchor: 'bottom' };
  // Wenig Platz über dem Panel (Handy): Bereich schließen, damit Karte, Hinweis und Weg Platz haben
  const pad = visiblePadding();
  if (section && window.innerHeight - pad.top - pad.bottom < 480) {
    pickHidSection = section;
    setSection(null);
  }
  courseMap?.setPickRoute(null);
  renderPick();
}

async function routePick(): Promise<void> {
  if (!event || !pick || pick.busy) return;
  if (!position) {
    pick.locating = true;
    renderPick();
    courseMap?.locate();
    return;
  }
  const ev = event;
  const current = pick;
  const from = position;
  const { mode, speed } = currentPlanSettings();
  current.busy = true;
  renderPick();
  const to = current.n.point;
  const now = Date.now();
  let route: Route;
  let arrive: number;
  let journey: Journey | undefined;
  if (mode === 'oepnv') {
    // Bus & Bahn ab jetzt; ist Laufen schneller, wird gelaufen
    const [walk, found] = await Promise.all([fetchRoute(ev, from, to, 'fuss'), fetchJourneys(from, to, now, false)]);
    const walkRoute = walk ?? estimatedRoute(from, to, DETOUR);
    const walkEnd = now + (walkRoute.distance / (speed / 3.6)) * 1000;
    const best = (found ?? []).filter((j) => j.start >= now - 30_000).sort((a, b) => a.end - b.end)[0];
    if (best && best.end < walkEnd) {
      journey = best;
      route = journeyRoute(best, from, to);
      arrive = best.end;
    } else if (!found && walkEnd - now > estimateTransitSeconds(from, to, speed) * 1000) {
      // Fahrplan nicht erreichbar: Schätzung
      route = estimatedRoute(from, to, DETOUR);
      arrive = now + estimateTransitSeconds(from, to, speed) * 1000;
    } else {
      route = walkRoute;
      arrive = walkEnd;
    }
  } else {
    route = (await fetchRoute(ev, from, to, mode)) ?? estimatedRoute(from, to, DETOUR);
    arrive = now + (route.distance / (speed / 3.6)) * 1000;
  }
  if (pick !== current || event !== ev) return; // inzwischen anderer Punkt oder anderes Rennen
  current.busy = false;
  current.route = route;
  current.journey = journey;
  current.arrive = arrive;
  // Hinweis auf die Seite, von der der Weg nicht kommt (sonst verdeckt er ihn)
  current.anchor = from.lat > current.n.point.lat ? 'top' : 'bottom';
  courseMap?.setPickRoute(route.points);
  renderPick();
  courseMap?.fitPick([from, ...route.points]);
  document.body.dataset.picked = String(Date.now());
}

function bindPick(): void {
  pickEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>('[data-pick-mode]');
    if (m && pick) {
      const mode = m.dataset.pickMode as Mode;
      if (mode === currentPlanSettings().mode) return;
      updatePlanSettings({ mode, speed: MODES[mode].kmh });
      const hadRoute = !!pick.route;
      pick.route = null;
      pick.journey = undefined;
      pick.arrive = null;
      courseMap?.setPickRoute(null);
      renderPick();
      // Plan-Bereich mitziehen, ohne das Panel neu aufzubauen (dort wird evtl. gerade getippt)
      if (!sheetBusy()) renderSheet();
      document.querySelectorAll<HTMLElement>('#sheet [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      const speedInput = document.querySelector<HTMLInputElement>('#plan-speed');
      if (speedInput) speedInput.value = String(MODES[mode].kmh).replace('.', ',');
      if (hadRoute) void routePick();
    } else if (t.closest('[data-testid="pick-go"]')) {
      void routePick();
    }
  });
}

// ---------------------------------------------------------------- Sichtungen

/** Zeitplan-Korrekturen aus den Sichtungen setzen; true = hat sich spürbar geändert. */
function applyOffsets(): boolean {
  const next = event ? offsetsFrom(event, sightings.list, new Date()) : new Map<string, number>();
  setSightingOffsets(next);
  const keys = new Set([...next.keys(), ...lastOffsets.keys()]);
  const changed = [...keys].some((k) => Math.abs((next.get(k) ?? 0) - (lastOffsets.get(k) ?? 0)) > 60_000);
  lastOffsets = next;
  return changed;
}

function onSightingsChange(): void {
  const changed = applyOffsets();
  renderAthleteMarkers();
  renderStatus();
  // Sichtungen sind die Antwort auf einen eigenen Tipp oder neue Infos → gleich zeigen
  if (changed) renderSheet();
  else renderSheetUnlessTyping();
  // Der Plan beruht auf den alten Zeiten → mit der echten Zeit neu planen
  if (changed && plan && !planBusy) void createPlan();
  document.body.dataset.sightings = String(sightings.list.length);
}

async function sightAthlete(i: number): Promise<void> {
  const a = event?.athletes[i];
  if (!event || !a?.id || !position) return;
  const now = Date.now();
  const along = sightingAlong(event, a, position, now);
  if (along === null) {
    toast('Du bist zu weit von der Strecke weg (mehr als 150 m).', 'error');
    return;
  }
  toast(`${a.name} bei km ${formatKm(along).replace(' km', '')} gesichtet – Zeitplan angepasst.`);
  await sightings.add(a.id, along, now);
}

/** Stand von einem anderen Gerät übernehmen. */
async function applyRemoteEvent(ev: RaceEvent): Promise<void> {
  const legsChanged = !event || JSON.stringify(ev.legs.map((l) => [l.name, l.discipline, l.points.length])) !== JSON.stringify(event.legs.map((l) => [l.name, l.discipline, l.points.length]));
  await setEvent(ev, legsChanged, true);
  toast('Event wurde von jemand anderem aktualisiert.');
}

/** @param remote Stand kommt vom Server (nicht wieder hochladen) */
async function setEvent(ev: RaceEvent | null, fit = true, remote = false): Promise<void> {
  // Strecke oder Athleten geändert → alter Plan passt nicht mehr
  if (plan) clearPlan();
  courseMap?.closePick();
  event = ev && ev.legs.length > 0 ? withIds(ev) : null;
  eventSync.update(event, !remote);
  sightings.setEvent(event?.athletes.length ? (event.id ?? null) : null);
  applyOffsets();
  if (!event) section = null;
  render(fit);
  await saveEvent(event);
  document.body.dataset.saved = event?.name ?? '';
}

// ---------------------------------------------------------------- Aktionen

async function importFiles(files: FileList): Promise<void> {
  let next: RaceEvent | null = event ? { ...event, legs: [...event.legs] } : null;
  let added = 0;
  for (const file of Array.from(files)) {
    try {
      const parsed = parseGpx(await file.text(), file.name);
      // Neues Rennen: zufällige Kennung (zwei Leute mit derselben GPX-Datei teilen sonst ein Event)
      if (!next) next = { id: randomId(), name: parsed.name ?? (file.name.replace(/\.gpx$/i, '') || 'Mein Rennen'), legs: [], date: null, athletes: [] };
      // Gleiche Vereinfachung wie im Teilen-Link → Sender und Empfänger sehen dieselben Zahlen
      next.legs.push(...parsed.legs.map(normalizeLeg));
      added += parsed.legs.length;
    } catch (e) {
      toast(e instanceof GpxError ? `${file.name}: ${e.message}` : `${file.name} konnte nicht gelesen werden.`, 'error');
    }
  }
  if (added > 0 && next) {
    // Nächster Schritt nach dem Laden: Athleten eintragen. Vor setEvent öffnen,
    // damit die Strecke in den Bereich über dem Panel eingepasst wird.
    const openAthletes = next.athletes.length === 0 && !section;
    if (openAthletes) section = 'athleten';
    await setEvent(next);
    toast(added === 1 ? 'Strecke geladen.' : `${added} Etappen geladen.`);
  }
}

async function openShare(): Promise<void> {
  if (!event) return;
  // Ab jetzt live: Änderungen sehen alle, die den Link haben
  void eventSync.share(event);
  const base = new URL(import.meta.env.BASE_URL, location.origin).toString();
  const url = await shareUrl(event, base);
  const dialog = $<HTMLDialogElement>('#share-dialog');
  $<HTMLInputElement>('#share-link').value = url;
  $('#share-native').hidden = typeof navigator.share !== 'function';
  $('#share-copy').textContent = 'Link kopieren';
  dialog.showModal();
}

function bindEvents(): void {
  $('#statusbar').addEventListener('click', () => setSection('athleten'));
  // Panel nach unten wischen schließt den Bereich (am Kopf anfassen)
  let dragStart: number | null = null;
  $('#sheet').addEventListener('touchstart', (e) => {
    const t = e.target as HTMLElement;
    dragStart = t.closest('.section-head') ? e.touches[0].clientY : null;
  }, { passive: true });
  $('#sheet').addEventListener('touchend', (e) => {
    if (dragStart !== null && e.changedTouches[0].clientY - dragStart > 60) setSection(null);
    dragStart = null;
  });
  const fileInput = $<HTMLInputElement>('#file-input');
  fileInput.addEventListener('change', async () => {
    if (fileInput.files?.length) await importFiles(fileInput.files);
    fileInput.value = '';
  });

  for (const type of ['pointerdown', 'scroll', 'keydown']) {
    $('#sheet').addEventListener(type, () => (lastSheetInteraction = Date.now()), { passive: true, capture: true });
  }

  $('#sheet').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#btn-load')) fileInput.click();
    else if (t.closest('#btn-share')) await openShare();
    else if (t.closest('[data-close-section]')) setSection(null);
    else if (t.closest('[data-sight]')) await sightAthlete(Number((t.closest('[data-sight]') as HTMLElement).dataset.sight));
    else if (t.closest('[data-unsight]')) {
      await sightings.remove((t.closest('[data-unsight]') as HTMLElement).dataset.unsight!);
      toast('Sichtung zurückgenommen.');
    }
    else if (t.closest('#btn-locate')) courseMap?.locate();
    else if (t.closest('[data-mode]')) {
      const m = (t.closest('[data-mode]') as HTMLElement).dataset.mode as Mode;
      updatePlanSettings({ mode: m, speed: MODES[m].kmh });
      clearPlan();
      renderSheet();
    } else if (t.closest('#btn-plan')) await createPlan();
    else if (t.closest('#btn-plan-clear')) {
      clearPlan();
      renderSheet();
    } else if (t.closest('[data-show-stop]') && plan) {
      const i = Number((t.closest('[data-show-stop]') as HTMLElement).dataset.showStop);
      const stop = plan.stops[i];
      const from = i === 0 ? plan.start : plan.stops[i - 1].candidate.point;
      if (stop) courseMap?.fitPoints([from, ...stop.route.points]);
    } else if (t.closest('#btn-add-athlete') && event) openAthleteDialog($<HTMLDialogElement>('#athlete-dialog'), event, null);
    else if (t.closest('.athlete-edit') && event) {
      const i = Number((t.closest('.athlete-edit') as HTMLElement).dataset.index);
      openAthleteDialog($<HTMLDialogElement>('#athlete-dialog'), event, i);
    }
    else if (t.closest('#btn-reset')) {
      if (confirm('Aktuelle Strecke verwerfen und ein anderes Rennen laden?')) await setEvent(null);
    } else if (t.closest('.leg-remove') && event) {
      const i = Number((t.closest('.leg-remove') as HTMLElement).dataset.index);
      await setEvent({ ...event, legs: event.legs.filter((_, j) => j !== i) }, false);
    }
  });

  $('#sheet').addEventListener('change', async (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'plan-people') {
      // Nur der Ticket-Tipp hängt davon ab → Plan behalten
      const n = Math.round(Number((t as HTMLInputElement).value));
      if (n >= 1 && n <= 30) updatePlanSettings({ people: n });
      if (plan) plan = { ...plan, settings: { ...plan.settings, people: currentPlanSettings().people } };
      renderSheet();
      return;
    }
    if (t.id === 'plan-athlete' || t.id === 'plan-stops' || t.id === 'plan-speed') {
      const v = (t as HTMLInputElement | HTMLSelectElement).value;
      if (t.id === 'plan-athlete') updatePlanSettings({ athleteIndex: Number(v) });
      if (t.id === 'plan-stops') updatePlanSettings({ maxStops: Number(v) });
      if (t.id === 'plan-speed') {
        const kmh = Number(v.replace(',', '.'));
        if (kmh >= 2 && kmh <= 40) updatePlanSettings({ speed: kmh });
      }
      clearPlan();
      renderSheet();
      return;
    }
    if (t instanceof HTMLInputElement && t.id === 'race-date' && event) {
      await setEvent({ ...event, date: /^\d{4}-\d{2}-\d{2}$/.test(t.value) ? t.value : null }, false);
      return;
    }
    if (t instanceof HTMLSelectElement && t.classList.contains('leg-discipline') && event) {
      const i = Number(t.dataset.index);
      const legs = event.legs.map((l, j) => (j === i ? { ...l, discipline: t.value as Discipline } : l));
      await setEvent({ ...event, legs }, false);
    }
  });

  const nameInput = $<HTMLInputElement>('#event-name');
  nameInput.addEventListener('change', async () => {
    if (!event) return;
    const name = nameInput.value.trim() || event.name;
    await setEvent({ ...event, name }, false);
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });

  $('#share-copy').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('#share-copy').textContent = 'Kopiert';
  });

  $('#share-native').addEventListener('click', async () => {
    if (!event) return;
    try {
      await navigator.share({ title: `${event.name} – SupBuddy`, url: $<HTMLInputElement>('#share-link').value });
    } catch {
      // Abgebrochen
    }
  });

  // Athleten-Dialog
  const athleteDialog = $<HTMLDialogElement>('#athlete-dialog');
  const athleteForm = $<HTMLFormElement>('#athlete-form');
  const athleteError = $('#athlete-error');
  athleteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!event) return;
    const result = readAthleteForm(athleteDialog);
    if (typeof result === 'string') {
      athleteError.textContent = result;
      athleteError.hidden = false;
      return;
    }
    const idx = athleteDialog.dataset.index;
    const athletes = [...event.athletes];
    // Kennung behalten (Sichtungen hängen daran), neue Athleten bekommen eine zufällige
    result.id = idx ? event.athletes[Number(idx)]?.id : randomId(12);
    if (idx) athletes[Number(idx)] = result;
    else athletes.push(result);
    athleteDialog.close();
    // Beim ersten Athleten den Renntag festhalten, damit der Teilen-Link ihn mitnimmt
    await setEvent({ ...event, athletes, date: event.date ?? isoDate(new Date()) }, false);
    toast(idx ? `${result.name} gespeichert.` : `${result.name} hinzugefügt.`);
  });
  $('#athlete-cancel').addEventListener('click', () => athleteDialog.close());
  $('#athlete-delete').addEventListener('click', async () => {
    const idx = athleteDialog.dataset.index;
    if (!event || !idx) return;
    const name = event.athletes[Number(idx)].name;
    athleteDialog.close();
    await setEvent({ ...event, athletes: event.athletes.filter((_, j) => j !== Number(idx)) }, false);
    toast(`${name} entfernt.`);
  });

  window.addEventListener('hashchange', () => void loadFromHash());
}

/** Ein Event aus dem Link übernehmen. Danach wird der Hash entfernt, damit Reloads den gespeicherten Stand nutzen. */
async function loadFromHash(): Promise<boolean> {
  const token = tokenFromHash(location.hash);
  if (!token) return false;
  try {
    await setEvent(await decodeEvent(token));
    saveLastLink(token, BUILD_LABEL);
    // Link geöffnet → den aktuellen Stand vom Server holen (der Link kann älter sein)
    if (event) void eventSync.share(event);
    toast('Strecke aus dem Link geladen.');
    return true;
  } catch {
    toast('Der Link ist unvollständig oder beschädigt. Lass ihn dir am besten nochmal schicken.', 'error');
    return false;
  } finally {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// ---------------------------------------------------------------- Start

async function start(): Promise<void> {
  const root = $('#app');
  shell(root);
  bindEvents();

  try {
    const { CourseMap } = await import('./map');
    courseMap = new CourseMap($('#map'), {
      onPosition: (p) => {
        // Beim Gehen kommen sekündlich neue Positionen: nur bei echter Bewegung neu aufbauen
        // Der erste Standort (oder sein Verlust) wird immer sofort angezeigt.
        const first = !position || !p;
        const moved = first || haversine(position!, p!) > 15;
        position = p;
        if (first || (moved && !sheetBusy())) renderSheet();
        if (first || moved) renderStatus();
        // Weg zum angetippten Punkt wartete auf den Standort
        if (pick?.locating) {
          pick.locating = false;
          if (p) void routePick();
          else {
            renderPick();
            toast('Standort nicht verfügbar. Erlaube den Standortzugriff und versuch es nochmal.', 'error');
          }
        }
      },
      onToggleMapOnly: () => {
        setMapOnly(!mapOnly);
      },
      getPadding: visiblePadding,
      onCoursePick: openPick,
      onSection: (s: Section) => setSection(section === s ? null : s),
      onPickClose: () => {
        pick = null;
        if (pickHidSection && !section) setSection(pickHidSection);
        pickHidSection = null;
      },
    });
    bindPick();
    // Beim Standort-Fix sollen auch die Athleten (bzw. die Strecke) ins Bild
    courseMap.focusPoints = (me) => {
      if (!event) return [];
      const moving = athletesNow(event, Date.now()).flatMap(({ plan }) => (plan.state === 'unterwegs' ? [plan.point] : []));
      if (moving.length) return moving;
      const n = nearestOnCourse(event, me);
      return n ? [n.point] : [];
    };
  } catch (e) {
    console.warn('Karte nicht verfügbar:', e);
    $('#map').innerHTML = '<p class="map-error">Die Karte kann auf diesem Gerät nicht angezeigt werden.</p>';
  }

  if (!(await loadFromHash())) {
    const loaded = await loadEvent();
    event = loaded && loaded.legs.length ? withIds(loaded) : null;
    // Neue App-Version: den zuletzt geöffneten Link noch einmal lesen (ältere Versionen
    // kannten evtl. noch nicht alles, was drinsteht – z. B. Kennungen für Sichtungen)
    const last = loadLastLink();
    if (event && last && last.build !== BUILD_LABEL) {
      try {
        event = adoptIds(event, await decodeEvent(last.token));
      } catch {
        // Link nicht lesbar → so lassen
      }
      saveLastLink(last.token, BUILD_LABEL);
    }
    if (event !== loaded) await saveEvent(event);
    sightings.setEvent(event?.athletes.length ? (event.id ?? null) : null);
    applyOffsets();
    render(true);
    eventSync.update(event, false);
    void eventSync.refresh();
  }
  document.body.dataset.ready = 'true';
}

void start();
window.setInterval(tick, 15_000);
// Sichtungen der anderen abholen (nur wenn die App sichtbar ist)
window.setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  void eventSync.refresh();
  if (event?.athletes.length) void sightings.refresh();
}, 20_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void eventSync.refresh();
  if (event?.athletes.length) void sightings.refresh();
});
registerSW({ immediate: true });
