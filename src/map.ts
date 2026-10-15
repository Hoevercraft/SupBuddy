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

export class CourseMap {
  private map: maplibregl.Map;
  private geolocate: maplibregl.GeolocateControl;
  private event: RaceEvent | null = null;
  private pins: maplibregl.Marker[] = [];
  private usingFallback = false;

  constructor(container: HTMLElement, onPosition: (p: Point | null) => void) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: GERMANY_CENTER,
      zoom: 5,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
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
    this.geolocate.on('geolocate', (pos: GeolocationPosition) =>
      onPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    );
    this.geolocate.on('error', () => onPosition(null));
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
    this.map.fitBounds(b, { padding: { top: 140, bottom: 260, left: 40, right: 40 }, maxZoom: 15, duration: 0 });
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
