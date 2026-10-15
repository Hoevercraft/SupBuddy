import { test, expect } from '@playwright/test';
import { collectErrors, openApp } from './helpers';

test('App lädt ohne Konsolenfehler und zeigt den Einstieg', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await expect(page).toHaveTitle('SupBuddy');
  await expect(page.getByRole('heading', { name: 'Welches Rennen schaust du?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GPX-Datei laden' })).toBeVisible();
  await expect(page.getByTestId('version')).toHaveText(/^v\d+\.\d+\.\d+$/);
  expect(errors).toEqual([]);
});

test('PWA-Manifest ist erreichbar und vollständig', async ({ page, request }) => {
  await openApp(page);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBe('SupBuddy');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test('Service Worker wird registriert', async ({ page }) => {
  await openApp(page);
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(registered).toBe(true);
});
