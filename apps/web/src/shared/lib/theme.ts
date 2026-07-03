import { useEffect, useState } from 'react';

/**
 * Theme tokens live as CSS custom properties on :root[data-theme="…"].
 * The theme id is persisted to localStorage and applied as a data-attribute
 * on <html>, so every component re-renders into the new palette without
 * a hard refresh.
 */

export type ThemeId = 'amethyst' | 'mocha' | 'rose' | 'obsidian';

export const THEMES: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'amethyst',  label: 'Amethyst Dusk', hint: 'Current velvet magenta' },
  { id: 'rose',      label: 'Rose Quartz',  hint: 'Soft, elegant, feminine' },
  { id: 'mocha',     label: 'Chocolate Mocha', hint: 'Rich, warm, unisex' },
  { id: 'obsidian',  label: 'Midnight Obsidian', hint: 'Sleek neon, minimalist' }
];

const STORAGE_KEY = 'cognexa.theme.v1';
const DEFAULT_THEME: ThemeId = 'amethyst';

function readStored(): ThemeId | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && THEMES.some((t) => t.id === raw)) return raw as ThemeId;
  } catch { /* ignore */ }
  return null;
}

function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute('data-theme', id);
  // Update the iOS status-bar tint to match the active palette.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      'content',
      id === 'mocha'    ? '#b45309' :
      id === 'rose'     ? '#ec4899' :
      id === 'obsidian' ? '#06b6d4' :
                          '#ed4f92'
    );
  }
}

/**
 * Apply the stored theme as early as possible — before the React tree mounts —
 * so the first paint already uses the right palette (no flash).
 */
export function bootstrapTheme(): ThemeId {
  const id = readStored() ?? DEFAULT_THEME;
  applyTheme(id);
  return id;
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeId>(() => bootstrapTheme());

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  return { theme, setTheme };
}
