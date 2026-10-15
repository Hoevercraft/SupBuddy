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
- Keine API-Keys im Code (Repo ist öffentlich). Externe Dienste bevorzugt keyless.
- Pfade relativ zu `import.meta.env.BASE_URL` bauen, nie hart `/SupBuddy/`.

## Befehle
- `npm run dev`, `npm run build`, `npm test`, `node scripts/make-icons.mjs`
