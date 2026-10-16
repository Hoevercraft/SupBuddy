import type { Journey } from './transit';
import { rideLegs } from './transit';

/*
 * Ticket-Tipp für die Supporter-Gruppe. Es gibt keine freie Preis-Schnittstelle, daher Regeln:
 * Länder-Tickets der DB (gelten in Regionalzügen und meist auch in Bus/Tram der Verbünde) mit
 * Preisen laut bahn.de (Stand 2026) und Hinweise auf Gruppenkarten großer Verbünde.
 * Welche Länder/Kreise befahren werden, steht vorne in den DELFI-Haltestellen-IDs („de:03355:…“).
 */

export const TICKET_PRICES_AS_OF = '2026';
export const LAENDER_URL = 'https://www.bahn.de/faq/pk/angebot/regionale-angebote/laender-tickets';

/** Bundesländer nach AGS-Schlüssel */
export const STATES: Record<string, string> = {
  '01': 'Schleswig-Holstein',
  '02': 'Hamburg',
  '03': 'Niedersachsen',
  '04': 'Bremen',
  '05': 'Nordrhein-Westfalen',
  '06': 'Hessen',
  '07': 'Rheinland-Pfalz',
  '08': 'Baden-Württemberg',
  '09': 'Bayern',
  '10': 'Saarland',
  '11': 'Berlin',
  '12': 'Brandenburg',
  '13': 'Mecklenburg-Vorpommern',
  '14': 'Sachsen',
  '15': 'Sachsen-Anhalt',
  '16': 'Thüringen',
};

export interface LandTicket {
  name: string;
  /** Gültig in diesen Ländern (AGS) */
  states: string[];
  /** Preis für n Personen (1–5) in € */
  price: (n: number, day: Date) => number;
  /** Mo–Fr erst ab 9 Uhr gültig */
  from9: boolean;
}

const perPerson = (first: number, extra: number) => (n: number) => first + extra * (n - 1);
const flat = (p: number) => () => p;

export const LAND_TICKETS: LandTicket[] = [
  { name: 'Niedersachsen-Ticket', states: ['03', '02', '04'], price: perPerson(29, 8), from9: false },
  { name: 'Schleswig-Holstein-Ticket', states: ['01', '02', '13'], price: perPerson(34, 6), from9: true },
  {
    name: 'Mecklenburg-Vorpommern-Ticket',
    states: ['13'],
    // Fr–So teurer
    price: (n, day) => ([0, 5, 6].includes(day.getDay()) ? 27 + 6 * (n - 1) : 25 + 5 * (n - 1)),
    from9: true,
  },
  { name: 'Brandenburg-Berlin-Ticket', states: ['12', '11'], price: flat(36.5), from9: true },
  { name: 'Hessenticket', states: ['06'], price: flat(43.5), from9: true },
  { name: 'Bayern-Ticket', states: ['09'], price: perPerson(34, 10), from9: true },
  { name: 'Baden-Württemberg-Ticket', states: ['08'], price: perPerson(27, 9), from9: false },
  { name: 'Rheinland-Pfalz-Ticket', states: ['07', '10'], price: perPerson(30, 10), from9: true },
  { name: 'Saarland-Ticket', states: ['10', '07'], price: perPerson(30, 10), from9: true },
  { name: 'Sachsen-Ticket', states: ['14', '15', '16'], price: perPerson(35, 8), from9: true },
  { name: 'Sachsen-Anhalt-Ticket', states: ['15', '14', '16'], price: perPerson(35, 8), from9: true },
  { name: 'Thüringen-Ticket', states: ['16', '14', '15'], price: perPerson(35, 8), from9: true },
  // NRW: 24h-Ticket für 1 Person oder bis 5 Personen
  { name: '24h-Ticket NRW', states: ['05'], price: (n) => (n === 1 ? 39.8 : 59.8), from9: false },
];

export interface VerbundHint {
  name: string;
  ticket: string;
  url: string;
  /** Kreise (AGS 5-stellig) bzw. Länder (2-stellig) */
  areas: string[];
}

/** Große Verbünde mit Gruppenkarte – Preise je Zone, daher nur Hinweis (ohne Preis). */
export const VERBUND_HINTS: VerbundHint[] = [
  {
    name: 'hvv',
    ticket: 'hvv-Gruppenkarte (bis 5 Personen)',
    url: 'https://www.hvv.de/de/fahrkarten',
    areas: ['02', '03353', '03355', '03359', '01053', '01056', '01060', '01061', '01062'],
  },
  {
    name: 'MVV',
    ticket: 'MVV-Gruppen-Tageskarte (2–5 Personen)',
    url: 'https://www.mvv-muenchen.de/tickets-abos-preise/gruppen-tageskarte/',
    areas: ['09162', '09184', '09174', '09175', '09177', '09178', '09179', '09188'],
  },
  {
    name: 'VBB',
    ticket: 'VBB-24-Stunden-Karte Kleingruppe (bis 5 Personen)',
    url: 'https://www.vbb.de/tickets/gruppenkarten/24-stunden-karte-kleingruppe',
    areas: ['11', '12'],
  },
];

export interface TicketTip {
  /** Keine Bus-/Bahnfahrt im Plan → kein Ticket nötig */
  none?: true;
  land?: { name: string; tickets: number; price: number; people: number; note?: string };
  verbund?: VerbundHint;
  /** Länder ohne passendes Länder-Ticket */
  uncovered?: string[];
}

/** Kreise (5-stellig) aller Haltestellen, an denen gefahren wird. */
export function usedAreas(journeys: Journey[]): string[] {
  const out = new Set<string>();
  for (const j of journeys)
    for (const l of rideLegs(j))
      for (const s of [l.from, l.to]) {
        const m = s.stopId?.match(/^de:(\d{5})/);
        if (m) out.add(m[1]);
      }
  return [...out];
}

const isWeekday = (d: Date) => d.getDay() >= 1 && d.getDay() <= 5;

/** Preis für die ganze Gruppe (mehrere Tickets ab 6 Personen). */
export function groupPrice(t: LandTicket, people: number, day: Date): { tickets: number; price: number } {
  const tickets = Math.ceil(people / 5);
  let price = 0;
  let left = people;
  for (let i = 0; i < tickets; i++) {
    const n = Math.min(5, left);
    price += t.price(n, day);
    left -= n;
  }
  return { tickets, price: Math.round(price * 100) / 100 };
}

export function suggestTicket(journeys: Journey[], people: number, day: Date): TicketTip {
  const rides = journeys.filter((j) => rideLegs(j).length > 0);
  if (!rides.length) return { none: true };
  const areas = usedAreas(rides);
  const states = [...new Set(areas.map((a) => a.slice(0, 2)))];
  const tip: TicketTip = {};

  const firstRide = Math.min(...rides.map((j) => rideLegs(j)[0].from.time));
  const early = isWeekday(day) && new Date(firstRide).getHours() < 9;
  const fitting = LAND_TICKETS.filter((t) => states.length > 0 && states.every((s) => t.states.includes(s)))
    // Ticket des Landes, in dem man hauptsächlich fährt, zuerst (z. B. Sachsen- statt Thüringen-Ticket)
    .sort((a, b) => Number(b.states[0] === states[0]) - Number(a.states[0] === states[0]));
  const options = fitting
    .map((t) => ({ t, ...groupPrice(t, people, day) }))
    .sort((a, b) => Number(early && a.t.from9) - Number(early && b.t.from9) || a.price - b.price);
  const best = options[0];
  if (best) {
    tip.land = {
      name: best.t.name,
      tickets: best.tickets,
      price: best.price,
      people,
      note: early && best.t.from9 ? 'Gilt Mo–Fr erst ab 9 Uhr – eure erste Fahrt ist früher.' : undefined,
    };
  } else if (states.length) {
    tip.uncovered = states.map((s) => STATES[s] ?? s);
  }
  tip.verbund = VERBUND_HINTS.find((v) => areas.length > 0 && areas.every((a) => v.areas.includes(a) || v.areas.includes(a.slice(0, 2))));
  return tip;
}

export const euro = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
