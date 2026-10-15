import { test, expect } from '@playwright/test';

test('App lädt ohne Konsolenfehler', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await expect(page).toHaveTitle('SupBuddy');
  await expect(page.getByRole('heading', { name: 'SupBuddy' })).toBeVisible();
  await expect(page.getByTestId('version')).toHaveText(/^v\d+\.\d+\.\d+$/);
  expect(errors).toEqual([]);
});

test('PWA-Manifest ist erreichbar und vollständig', async ({ page, request }) => {
  await page.goto('/');
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
  await page.goto('/');
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(registered).toBe(true);
});
