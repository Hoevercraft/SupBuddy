import { defineConfig, devices } from '@playwright/test';

// Tests laufen gegen den Produktions-Build (vite preview),
// damit Service Worker und Manifest realistisch geprüft werden.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    // Uhrzeiten im Zeitplan sind Ortszeit: Tests laufen wie ein Gerät in Deutschland
    timezoneId: 'Europe/Berlin',
    locale: 'de-DE',
    // WebGL für MapLibre im Headless-Browser (Software-Rendering)
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Jan und die meisten Supporter nutzen iPhones → WebKit (Safari-Engine) muss mitlaufen
    { name: 'iphone', use: { ...devices['iPhone 14'], launchOptions: {} } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
