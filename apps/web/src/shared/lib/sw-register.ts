/**
 * Register service worker for PWA (Installable on iOS / Android / macOS via "Add to Home Screen").
 */
export function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => console.warn('[sw] register failed', err));
    });
  }
}
