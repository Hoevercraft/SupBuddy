import type { Page } from '@playwright/test';
import path from 'node:path';

export const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);

/**
 * Kartenkacheln blockieren: Tests sollen nicht vom Kartendienst abhängen.
 * Die App fällt dann auf den Ersatzstil zurück, die Strecke bleibt sichtbar.
 */
export async function blockTiles(page: Page): Promise<void> {
  await page.route(/tiles\.openfreemap\.org/, (route) => route.abort());
}

/** Konsolenfehler sammeln, außer erwartbaren Netzwerkfehlern der blockierten Kacheln. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|openfreemap/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

export async function openApp(page: Page, hash = ''): Promise<void> {
  await blockTiles(page);
  await page.goto(`/${hash}`);
  await page.locator('body[data-ready="true"]').waitFor();
}
