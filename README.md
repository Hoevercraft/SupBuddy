# SupBuddy

Web-App (PWA), gebaut mit Vite + TypeScript, ausgeliefert über GitHub Pages.
Später soll dieselbe Codebasis per [Capacitor](https://capacitorjs.com/) als iOS- und Android-App laufen.

**Live:** https://hoevercraft.github.io/SupBuddy/

## Entwicklung

```bash
npm install
npm run dev          # Dev-Server auf http://localhost:5173
npm run build        # Produktions-Build nach dist/
npm run test:install # einmalig: Chromium für Playwright
npm test             # Smoke-Tests gegen den Produktions-Build
```

## Deployment

Jeder Push auf `main` läuft durch `.github/workflows/deploy.yml`:
Tests → Build (mit `BASE_PATH=/SupBuddy/`) → GitHub Pages.
Pull Requests werden nur getestet, nicht deployt.

Einmalig nötig: **Settings → Pages → Source: „GitHub Actions“**.

## Projektstruktur

```
index.html            Einstieg
src/main.ts           App-Start
src/style.css         Basis-Styles (Mobile first, Safe Areas)
public/               Icons, statische Assets
tests/                Playwright-Tests (mobile + desktop)
scripts/make-icons.mjs  PNG-Icons aus public/icon.svg erzeugen
```

## Weg zu iOS/Android

Die App ist so aufgesetzt, dass Capacitor direkt darauf aufsetzen kann:
`base` ist lokal `/`, Safe-Area-Insets sind berücksichtigt, keine serverseitigen Abhängigkeiten.
Ablauf später: `npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android`,
`npx cap init SupBuddy <bundle-id> --web-dir dist`, `npx cap add ios` / `npx cap add android`.
