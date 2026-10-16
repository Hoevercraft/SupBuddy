import type { FeatureCollection } from 'geojson';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bounds } from './geo';
import { DISCIPLINES, type Point, type RaceEvent } from './model';

/** Freie OSM-Vektorkarte ohne API-Key. */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Falls die Kartenkacheln nicht laden (offline, gesperrt): schlichter Hintergrund, Strecke bleibt sichtbar. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#E9EEF2' } }],
};

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

export interface CourseMapOptions {
  onPosition: (p: Point | null) => void;
  onToggleMapOnly: () => void;
}

export class CourseMap {
  private map: maplibregl.Map;
  private geolocate: maplibregl.GeolocateControl;
  private event: RaceEvent | null = null;
  private pins: maplibregl.Marker[] = [];
  private athletePins = new Map<string, maplibregl.Marker>();
  private usingFallback = false;
  private mapOnlyToggle: MapOnlyToggle;

  constructor(container: HTMLElement, { onPosition, onToggleMapOnly }: CourseMapOptions) {
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

    this.geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showAccuracyCircle: true,
    });
    this.map.addControl(this.geolocate, 'top-right');
    this.mapOnlyToggle = new MapOnlyToggle(onToggleMapOnly);
    this.map.addControl(this.mapOnlyToggle, 'top-right');
    this.map.addControl(new maplibregl.AttributionControl({
        compact: true,
        // Immer sichtbar, auch wenn nur der Ersatzstil geladen ist
        customAttribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
      }), 'top-right');
    this.geolocate.on('geolocate', (pos: GeolocationPosition) =>
      onPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    );
    this.geolocate.on('error', () => onPosition(null));
  }

  setMapOnly(on: boolean): void {
    this.mapOnlyToggle.setPressed(on);
  }

  /** Standort anfordern (zeigt beim ersten Mal die Berechtigungsabfrage). */
  locate(): void {
    this.geolocate.trigger();
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
    this.map.fitBounds(b, { padding: { top: 100, bottom: 260, left: 40, right: 60 }, maxZoom: 15, duration: 0 });
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
    this.pins.push(
      new maplibregl.Marker({ element: pinElement('Start', 'pin-start') }).setLngLat([first.lng, first.lat]).addTo(this.map),
      new maplibregl.Marker({ element: pinElement('Ziel', 'pin-finish') }).setLngLat([last.lng, last.lat]).addTo(this.map),
    );
  }
}
