import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/800.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { athleteDialogHtml, athletesNow, athletesSection, initials, openAthleteDialog, readAthleteForm } from './athletes-ui';
import { courseStats, legDistance, nearestOnCourse } from './course';
import { isoDate } from './format';
import { formatDistance, formatKm } from './geo';
import { GpxError, parseGpx } from './gpx';
import { DISCIPLINES, eventKind, type Discipline, type Point, type RaceEvent } from './model';
import { decodeEvent, normalizeLeg, shareUrl, tokenFromHash } from './share';
import { loadEvent, saveEvent } from './store';

export const APP_VERSION = __APP_VERSION__;
/** Zum Troubleshooting: ändert sich mit jedem Deploy. */
export const BUILD_LABEL = `v${__APP_VERSION__} · ${__APP_COMMIT__} · ${__APP_BUILD_TIME__}`;

// ---------------------------------------------------------------- Zustand

let event: RaceEvent | null = null;
let position: Point | null = null;
let mapOnly = false;
let courseMap: import('./map').CourseMap | null = null;

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

function renderSheet(): void {
  const sheet = $('#sheet');
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

  sheet.innerHTML = `
    ${positionText()}
    ${athletesSection(event, position, Date.now())}
    <h3 class="sheet-sub">Strecke</h3>
    <ul class="legs">${legs}</ul>
    <div class="actions">
      <button class="btn btn-primary" id="btn-share" type="button">Link teilen</button>
      <button class="btn" id="btn-load" type="button">Etappe hinzufügen</button>
    </div>
    <button class="btn btn-quiet" id="btn-reset" type="button">Anderes Rennen laden</button>
  `;
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
  renderBib();
  renderSheet();
  courseMap?.setEvent(event, fit);
  renderAthleteMarkers();
}

/** Plan-Positionen laufen mit der Uhr: regelmäßig auffrischen, ohne laufende Eingaben zu stören. */
function tick(): void {
  if (!event || event.athletes.length === 0) return;
  renderAthleteMarkers();
  const sheet = $('#sheet');
  const busy = sheet.contains(document.activeElement) && document.activeElement !== document.body;
  if (!busy && !$<HTMLDialogElement>('#athlete-dialog').open) renderSheet();
}

async function setEvent(ev: RaceEvent | null, fit = true): Promise<void> {
  event = ev && ev.legs.length > 0 ? ev : null;
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
      if (!next) next = { name: parsed.name ?? (file.name.replace(/\.gpx$/i, '') || 'Mein Rennen'), legs: [], date: null, athletes: [] };
      // Gleiche Vereinfachung wie im Teilen-Link → Sender und Empfänger sehen dieselben Zahlen
      next.legs.push(...parsed.legs.map(normalizeLeg));
      added += parsed.legs.length;
    } catch (e) {
      toast(e instanceof GpxError ? `${file.name}: ${e.message}` : `${file.name} konnte nicht gelesen werden.`, 'error');
    }
  }
  if (added > 0 && next) {
    await setEvent(next);
    toast(added === 1 ? 'Strecke geladen.' : `${added} Etappen geladen.`);
  }
}

async function openShare(): Promise<void> {
  if (!event) return;
  const base = new URL(import.meta.env.BASE_URL, location.origin).toString();
  const url = await shareUrl(event, base);
  const dialog = $<HTMLDialogElement>('#share-dialog');
  $<HTMLInputElement>('#share-link').value = url;
  $('#share-native').hidden = typeof navigator.share !== 'function';
  $('#share-copy').textContent = 'Link kopieren';
  dialog.showModal();
}

function bindEvents(): void {
  const fileInput = $<HTMLInputElement>('#file-input');
  fileInput.addEventListener('change', async () => {
    if (fileInput.files?.length) await importFiles(fileInput.files);
    fileInput.value = '';
  });

  $('#sheet').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#btn-load')) fileInput.click();
    else if (t.closest('#btn-share')) await openShare();
    else if (t.closest('#btn-locate')) courseMap?.locate();
    else if (t.closest('#btn-add-athlete') && event) openAthleteDialog($<HTMLDialogElement>('#athlete-dialog'), event, null);
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
        position = p;
        renderSheet();
      },
      onToggleMapOnly: () => setMapOnly(!mapOnly),
    });
  } catch (e) {
    console.warn('Karte nicht verfügbar:', e);
    $('#map').innerHTML = '<p class="map-error">Die Karte kann auf diesem Gerät nicht angezeigt werden.</p>';
  }

  if (!(await loadFromHash())) {
    event = await loadEvent();
    render(true);
  }
  document.body.dataset.ready = 'true';
}

void start();
window.setInterval(tick, 15_000);
registerSW({ immediate: true });
