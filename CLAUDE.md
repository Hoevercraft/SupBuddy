# CLAUDE.md – SupBuddy

## Kontext
- Owner: Jan (Hoevercraft). Kommunikation auf Deutsch.
- Schwesterprojekt: veloai (gleiche Grundidee: statische Web-App auf GitHub Pages, von Claude selbst testbar).
- Ziel: zuerst Web (PWA), später iOS/Android per Capacitor aus derselben Codebasis.

## Stack
- Vite + TypeScript (strict), kein UI-Framework bisher.
- vite-plugin-pwa (Manifest + Service Worker, autoUpdate).
- Playwright für Tests, Projekte `mobile` (Pixel 7) und `desktop`.

## Arbeitsweise
- Vor jedem Commit: `npm run build` und `npm test` müssen grün sein.
- Neue Features bekommen mindestens einen Playwright-Test.
- Features über Branch + Pull Request; `main` deployt automatisch.
- Keine Browser-APIs nutzen, die in einer Capacitor-WebView fehlen, ohne Fallback.
- Keine geheimen Schlüssel im Code (Repo ist öffentlich). Externe Dienste bevorzugt keyless.
  Ausnahme Supabase: URL + publishable key sind öffentlich (stehen in `src/backend.ts`), die Sicherheit
  liegt in `supabase/schema.sql` (Tabelle nicht veröffentlicht, nur geprüfte Funktionen). Secret-/service_role-Key und
  DB-Passwort NIE ins Repo. Schema-Änderungen: SQL-Datei anpassen, Jan führt sie im Supabase SQL Editor aus.
- Tests sprechen nie den echten Supabase-Dienst an (`navigator.webdriver` → Attrappe aus `tests/helpers.ts`).
- Pfade relativ zu `import.meta.env.BASE_URL` bauen, nie hart `/SupBuddy/`.

## Befehle
- `npm run dev`, `npm run build`, `npm test`, `node scripts/make-icons.mjs`
