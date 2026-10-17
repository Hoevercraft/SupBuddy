import { defineConfig, devices } from '@playwright/test';

// Logik-Tests laufen in Node: dort dieselbe Zeitzone wie im Browser (CI läuft sonst in UTC)
process.env.TZ = 'Europe/Berlin';

// Tests laufen gegen den Produktions-Build (vite preview),
// damit Service Worker und Manifest realistisch geprüft werden.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  // Karten-Rendering per Software ist langsam (CI, Sandbox): großzügiges Limit je Test
  timeout: 60_000,
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
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
      // Lokal (z. B. in Claudes Sandbox) einen vorhandenen Chromium nutzen statt herunterzuladen
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    },
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
