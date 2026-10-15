import './style.css';
import { registerSW } from 'virtual:pwa-register';

export const APP_VERSION = __APP_VERSION__;

function render(root: HTMLElement): void {
  root.innerHTML = `
    <header class="app-header">
      <h1>SupBuddy</h1>
    </header>
    <main class="app-main">
      <p data-testid="status">Grundgerüst steht – Features folgen.</p>
    </main>
    <footer class="app-footer">
      <small data-testid="version">v${APP_VERSION}</small>
    </footer>
  `;
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('#app fehlt');
render(root);

registerSW({ immediate: true });
