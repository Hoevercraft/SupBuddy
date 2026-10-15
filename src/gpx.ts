import { elevationGain } from './geo';
import { guessDiscipline, type Discipline, type Leg, type Point } from './model';

export class GpxError extends Error {}

function readPoint(el: Element): Point | null {
  const lat = parseFloat(el.getAttribute('lat') ?? '');
  const lng = parseFloat(el.getAttribute('lon') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const eleText = el.getElementsByTagName('ele')[0]?.textContent;
  const ele = eleText != null ? parseFloat(eleText) : NaN;
  return Number.isFinite(ele) ? { lat, lng, ele } : { lat, lng };
}

function directName(el: Element): string | null {
  for (const child of Array.from(el.children)) {
    if (child.localName === 'name') return child.textContent?.trim() || null;
  }
  return null;
}

export interface ParsedGpx {
  name: string | null;
  legs: Leg[];
}

/**
 * Liest eine GPX-Datei. Jeder <trk> (alle Segmente zusammengehängt) und jede <rte>
 * wird zu einer Etappe. Die Disziplin wird aus Etappen- bzw. Dateiname geraten.
 */
export function parseGpx(xml: string, fileName = '', fallback: Discipline = 'rad'): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new GpxError('Die Datei ist kein gültiges GPX (XML-Fehler).');
  }
  const root = doc.documentElement;
  if (root.localName !== 'gpx') throw new GpxError('Die Datei ist kein GPX.');

  const metaName =
    root.getElementsByTagName('metadata')[0]?.getElementsByTagName('name')[0]?.textContent?.trim() || null;
  const baseName = fileName.replace(/\.gpx$/i, '');

  const legs: Leg[] = [];
  const containers: { el: Element; tag: string }[] = [
    ...Array.from(root.getElementsByTagName('trk')).map((el) => ({ el, tag: 'trkpt' })),
    ...Array.from(root.getElementsByTagName('rte')).map((el) => ({ el, tag: 'rtept' })),
  ];

  containers.forEach(({ el, tag }, i) => {
    const points = Array.from(el.getElementsByTagName(tag))
      .map(readPoint)
      .filter((p): p is Point => p !== null);
    if (points.length < 2) return;
    const name = directName(el) ?? (containers.length > 1 ? `${baseName || 'Etappe'} ${i + 1}` : baseName || 'Strecke');
    const discipline = guessDiscipline(name, guessDiscipline(baseName, fallback));
    legs.push({ name, discipline, points, elevationGain: elevationGain(points) });
  });

  if (legs.length === 0) throw new GpxError('In der Datei wurde keine Strecke gefunden.');
  return { name: metaName, legs };
}
