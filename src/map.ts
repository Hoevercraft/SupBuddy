import type { FeatureCollection } from 'geojson';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bounds, haversine } from './geo';
import { DISCIPLINES, type Point, type RaceEvent } from './model';

/** Freie OSM-Vektorkarte ohne API-Key. */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Falls die Kartenkacheln nicht laden (offline, gesperrt): schlichter Hintergrund, Strecke bleibt sichtbar. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#E9EEF2' } }],
};

/** Farbe der Plan-Wege (für Pixelprüfung in Tests exportiert). */
export const PLAN_COLOR = '#312E81';

const GERMANY_CENTER: [number, number] = [10.45, 51.16];

function courseGeoJSON(ev: RaceEvent | null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: (ev?.legs ?? []).map((leg, i) => ({
      type: 'Feature',
      properties: { color: DISCIPLINES[leg.discipline].color, index: i },
      geometry: { type: 'LineString', coordinates: leg.points.map((p) => [p.lng, p.lat]) },
    })),
  };
}

function pinElement(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `pin ${cls}`;
  el.textContent = text;
  return el;
}

const ICON_EXPAND =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_COLLAPSE =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

/** Knopf auf der Karte: blendet Startnummer und Panel aus/ein. */
class MapOnlyToggle implements maplibregl.IControl {
  private container = document.createElement('div');
  private button = document.createElement('button');

  constructor(private onToggle: () => void) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group ctrl-maponly';
    this.button.type = 'button';
    this.button.className = 'ctrl-maponly-btn';
    this.button.addEventListener('click', () => this.onToggle());
    this.container.appendChild(this.button);
    this.setPressed(false);
  }

  setPressed(on: boolean): void {
    const label = on ? 'Vollbild beenden' : 'Vollbild';
    this.button.setAttribute('aria-pressed', String(on));
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
    this.button.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
  }

  onAdd(): HTMLElement {
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}

export interface AthleteMarker {
  label: string;
  name: string;
  color: string;
  /** null = nicht auf der Strecke (vor dem Start oder im Ziel) */
  point: Point | null;
}

function athleteElement(a: AthleteMarker): HTMLElement {
  const el = document.createElement('div');
  el.className = 'athlete-pin';
  el.dataset.testid = 'athlete-pin';
  el.style.setProperty('--athlete-color', a.color);
  el.innerHTML = '<span class="athlete-pin-dot"></span><span class="athlete-pin-name"></span>';
  el.querySelector('.athlete-pin-dot')!.textContent = a.label;
  el.querySelector('.athlete-pin-name')!.textContent = a.name;
  el.title = `${a.name} – Position laut Plan`;
  return el;
}

/**
 * Eigener Standort-Knopf statt MapLibres GeolocateControl:
 * Der Punkt folgt dem Gerät (watchPosition), die Kamera aber nicht –
 * den Ausschnitt bestimmt die App (dich + Athleten im Bild).
 */
class LocateControl implements maplibregl.IControl {
  private container = document.createElement('div');
  private button = document.createElement('button');
  private watchId: number | null = null;
  private dot: maplibregl.Marker | null = null;
  private map: maplibregl.Map | null = null;

  constructor(private onFix: (p: Point) => void, private onError: () => void) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button.type = 'button';
    this.button.className = 'maplibregl-ctrl-geolocate';
    this.button.setAttribute('aria-label', 'Meinen Standort zeigen');
    this.button.title = 'Meinen Standort zeigen';
    this.button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';
    this.button.addEventListener('click', () => this.onClick?.());
    this.container.appendChild(this.button);
  }

  /** Wird beim Tippen auf den Knopf aufgerufen (von CourseMap gesetzt). */
  onClick: (() => void) | null = null;

  start(): void {
    if (!('geolocation' in navigator)) return this.onError();
    if (this.watchId != null) return;
    this.button.classList.add('maplibregl-ctrl-geolocate-waiting');
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this.button.classList.remove('maplibregl-ctrl-geolocate-waiting');
        this.button.classList.add('maplibregl-ctrl-geolocate-active');
        if (!this.dot && this.map) {
          const el = document.createElement('div');
          el.className = 'maplibregl-user-location-dot';
          el.dataset.testid = 'user-dot';
          this.dot = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(this.map);
        } else {
          this.dot?.setLngLat([p.lng, p.lat]);
        }
        this.onFix(p);
      },
      () => {
        this.stop();
        this.onError();
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
  }

  private stop(): void {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.button.classList.remove('maplibregl-ctrl-geolocate-waiting', 'maplibregl-ctrl-geolocate-active');
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    return this.container;
  }

  onRemove(): void {
    this.stop();
    this.dot?.remove();
    this.container.remove();
  }
}

export type Padding = { top: number; bottom: number; left: number; right: number };

export interface CourseMapOptions {
  onPosition: (p: Point | null) => void;
  onToggleMapOnly: () => void;
  /** Frei sichtbarer Kartenbereich (Startnummer oben, Panel unten abziehen). */
  getPadding: () => Padding;
}

export class CourseMap {
  private map: maplibregl.Map;
  private locator: LocateControl;
  private getPadding: () => Padding;
  /** Nach dem nächsten Standort-Fix den Ausschnitt anpassen (nur nach Tippen auf „Standort“). */
  private fitOnFix = false;
  /** Liefert die Punkte, die beim Standort-Fix zusätzlich ins Bild sollen (Athleten). */
  focusPoints: (me: Point) => Point[] = () => [];
  private event: RaceEvent | null = null;
  private pins: maplibregl.Marker[] = [];
  private athletePins = new Map<string, maplibregl.Marker>();
  private stopPins: maplibregl.Marker[] = [];
  private planGeoJSON: FeatureCollection = { type: 'FeatureCollection', features: [] };
  private usingFallback = false;
  private contextLost = 0;
  private mapOnlyToggle: MapOnlyToggle;

  constructor(container: HTMLElement, { onPosition, onToggleMapOnly, getPadding }: CourseMapOptions) {
    this.getPadding = getPadding;
    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: GERMANY_CENTER,
      zoom: 5,
      // Quellenhinweis oben rechts: unten verdeckt ihn auf dem Handy das Panel
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      // Bild nach dem Zeichnen behalten: Screenshots (Tests, Teilen) zeigen dann genau das Angezeigte
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    // Zustand für Fehlersuche und Tests abrufbar machen
    (window as unknown as { __supbuddyMap?: () => unknown }).__supbuddyMap = () => this.debugState();
    this.map.touchZoomRotate.disableRotation();

    this.map.on('error', (e) => {
      // Stil oder Kacheln nicht ladbar → auf Ersatzstil wechseln, statt eine leere Karte zu zeigen
      if (!this.usingFallback && !this.map.isStyleLoaded()) {
        this.usingFallback = true;
        console.warn('Kartenstil nicht ladbar, nutze Ersatz:', e.error?.message);
        this.map.setStyle(FALLBACK_STYLE);
      } else {
        console.warn('Kartenfehler:', e.error?.message);
      }
    });
    this.map.on('style.load', () => this.addCourseLayers());
    this.map.on('webglcontextlost', () => this.contextLost++);

    this.locator = new LocateControl(
      (p) => {
        onPosition(p);
        if (this.fitOnFix) {
          this.fitOnFix = false;
          this.fitPoints([p, ...this.focusPoints(p)]);
        }
      },
      () => onPosition(null),
    );
    this.locator.onClick = () => this.locate();
    this.map.addControl(this.locator, 'top-right');
    this.mapOnlyToggle = new MapOnlyToggle(onToggleMapOnly);
    this.map.addControl(this.mapOnlyToggle, 'top-right');
    const attribution = new maplibregl.AttributionControl({
        compact: true,
        // Immer sichtbar, auch wenn nur der Ersatzstil geladen ist
        customAttribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
      });
    this.map.addControl(attribution, 'top-right');
    // MapLibre zeigt den Quellenhinweis anfangs ausgeklappt (breiter Textbalken über der Karte)
    // und klappt ihn erst beim ersten Verschieben ein → direkt eingeklappt starten, (i) klappt auf.
    const collapse = () =>
      container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
    collapse();
    this.map.once('load', collapse);
    this.map.once('idle', collapse);
  }

  setMapOnly(on: boolean): void {
    this.mapOnlyToggle.setPressed(on);
  }

  /** Standort anfordern (zeigt beim ersten Mal die Berechtigungsabfrage). */
  locate(): void {
    this.fitOnFix = true;
    this.locator.start();
  }

  /** Ausschnitt so wählen, dass alle Punkte im frei sichtbaren Bereich liegen. */
  fitPoints(points: Point[]): void {
    const b = bounds(points);
    if (!b) return;
    this.map.fitBounds(b, { padding: this.safePadding(), maxZoom: 15, duration: 600 });
  }

  /** Padding begrenzen, damit fitBounds auf kleinen Bildschirmen nicht scheitert. */
  private safePadding(): Padding {
    const p = this.getPadding();
    const c = this.map.getContainer();
    const maxV = Math.max(0, c.clientHeight - 80);
    const maxH = Math.max(0, c.clientWidth - 80);
    const scale = (a: number, b: number, max: number) => (a + b > max ? max / (a + b) : 1);
    const sv = scale(p.top, p.bottom, maxV);
    const sh = scale(p.left, p.right, maxH);
    return { top: p.top * sv, bottom: p.bottom * sv, left: p.left * sh, right: p.right * sh };
  }

  setEvent(ev: RaceEvent | null, fit = true): void {
    this.event = ev;
    const src = this.map.getSource('course') as GeoJSONSource | undefined;
    src?.setData(courseGeoJSON(ev));
    this.updatePins();
    if (fit) this.fit();
  }

  fit(): void {
    const all = this.event?.legs.flatMap((l) => l.points) ?? [];
    const b = bounds(all);
    if (!b) return;
    this.map.fitBounds(b, { padding: this.safePadding(), maxZoom: 15, duration: 0 });
  }

  /** Kurzbericht zum Kartenzustand (für Tests und Fehlersuche). */
  debugState() {
    const src = this.map.getSource('course') as GeoJSONSource | undefined;
    const canvas = this.map.getCanvas();
    return {
      styleLoaded: this.map.isStyleLoaded(),
      usingFallback: this.usingFallback,
      hasCourseSource: !!src,
      hasCourseLayer: !!this.map.getLayer('course-line'),
      legs: this.event?.legs.length ?? 0,
      planRoutes: this.planGeoJSON.features.length,
      hasPlanLayer: !!this.map.getLayer('plan-routes'),
      stopPins: this.stopPins.length,
      glLost: (this.map.getCanvas().getContext('webgl2') ?? this.map.getCanvas().getContext('webgl'))?.isContextLost() ?? 'n/a',
      contextLostEvents: this.contextLost,
      renderedPlan: this.map.getLayer('plan-routes') ? this.map.queryRenderedFeatures({ layers: ['plan-routes'] }).length : -1,
      renderedCourse: this.map.getLayer('course-line') ? this.map.queryRenderedFeatures({ layers: ['course-line'] }).length : -1,
      planLayerOrder: this.map.getStyle()?.layers?.map((l) => l.id).join(','),
      // Bildschirmpositionen (CSS-Pixel) entlang des ersten Weges
      planScreen: (this.planGeoJSON.features[0]?.geometry as { coordinates?: number[][] } | undefined)?.coordinates
        ?.map((c) => this.map.project([c[0], c[1]]))
        .map((p) => [Math.round(p.x), Math.round(p.y)]),
      zoom: Math.round(this.map.getZoom() * 10) / 10,
      canvas: `${canvas.width}x${canvas.height}`,
      loaded: this.map.loaded(),
    };
  }

  private addCourseLayers(): void {
    if (this.map.getSource('course')) return;
    this.map.addSource('course', { type: 'geojson', data: courseGeoJSON(this.event) });
    this.map.addLayer({
      id: 'course-casing',
      type: 'line',
      source: 'course',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 15, 11] },
    });
    this.map.addLayer({
      id: 'course-line',
      type: 'line',
      source: 'course',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 15, 6],
      },
    });
    // Wege zu den Anfeuer-Stopps: Indigo mit weißem Rand, über der Strecke
    this.map.addSource('plan-routes', { type: 'geojson', data: this.planGeoJSON });
    this.map.addLayer({
      id: 'plan-routes-casing',
      type: 'line',
      source: 'plan-routes',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#FFFFFF', 'line-width': 9 },
    });
    this.map.addLayer({
      id: 'plan-routes',
      type: 'line',
      source: 'plan-routes',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      // Durchgezogen statt gestrichelt: gestrichelte Linien rendern manche Grafiktreiber nicht zuverlässig
      paint: { 'line-color': PLAN_COLOR, 'line-width': 5 },
    });
  }

  /** Anfeuer-Plan anzeigen: nummerierte Stopps + Wege dorthin. Leere Liste = Plan entfernen. */
  setPlan(stops: { point: Point }[], routes: Point[][]): void {
    this.stopPins.forEach((m) => m.remove());
    this.stopPins = stops.map((s, i) => {
      const el = document.createElement('div');
      el.className = 'stop-pin';
      el.dataset.testid = 'stop-pin';
      el.textContent = String(i + 1);
      // Über dem Punkt, damit Start/Ziel-Schilder (unter dem Punkt) sichtbar bleiben
      return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -2] }).setLngLat([s.point.lng, s.point.lat]).addTo(this.map);
    });
    this.planGeoJSON = {
      type: 'FeatureCollection',
      features: routes.map((r) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: r.map((p) => [p.lng, p.lat]) },
      })),
    };
    (this.map.getSource('plan-routes') as GeoJSONSource | undefined)?.setData(this.planGeoJSON);
  }

  /** Athleten an ihre Plan-Position setzen (wiederverwendet Marker, damit nichts flackert). */
  setAthletes(items: AthleteMarker[]): void {
    const keep = new Set<string>();
    for (const a of items) {
      if (!a.point) continue;
      const key = `${a.name}|${a.color}`;
      keep.add(key);
      let m = this.athletePins.get(key);
      if (!m) {
        m = new maplibregl.Marker({ element: athleteElement(a), anchor: 'left', offset: [-14, 0] });
        m.setLngLat([a.point.lng, a.point.lat]).addTo(this.map);
        this.athletePins.set(key, m);
      } else {
        m.setLngLat([a.point.lng, a.point.lat]);
      }
    }
    for (const [key, m] of this.athletePins) {
      if (!keep.has(key)) {
        m.remove();
        this.athletePins.delete(key);
      }
    }
  }

  private updatePins(): void {
    this.pins.forEach((m) => m.remove());
    this.pins = [];
    const legs = this.event?.legs ?? [];
    if (legs.length === 0) return;
    const first = legs[0].points[0];
    const lastLeg = legs[legs.length - 1];
    const last = lastLeg.points[lastLeg.points.length - 1];
    // Rundkurs: Start und Ziel liegen (fast) aufeinander → ein gemeinsamer Marker statt zwei verdeckter
    if (haversine(first, last) < 150) {
      this.pins.push(
        new maplibregl.Marker({ element: pinElement('Start/Ziel', 'pin-start pin-finish'), anchor: 'top', offset: [0, 4] })
          .setLngLat([first.lng, first.lat])
          .addTo(this.map),
      );
      return;
    }
    this.pins.push(
      new maplibregl.Marker({ element: pinElement('Start', 'pin-start'), anchor: 'top', offset: [0, 4] }).setLngLat([first.lng, first.lat]).addTo(this.map),
      new maplibregl.Marker({ element: pinElement('Ziel', 'pin-finish'), anchor: 'top', offset: [0, 4] }).setLngLat([last.lng, last.lat]).addTo(this.map),
    );
  }
}
