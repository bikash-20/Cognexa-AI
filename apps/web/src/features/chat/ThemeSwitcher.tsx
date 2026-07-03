import { useState, useRef, useEffect } from 'react';
import { THEMES, useTheme, type ThemeId } from '../../shared/lib/theme';

const SWATCH: Record<ThemeId, string> = {
  amethyst: 'linear-gradient(135deg, #ff9fc1, #ad1f5f)',
  rose:     'linear-gradient(135deg, #f9a8d4, #ec4899)',
  mocha:    'linear-gradient(135deg, #fbbf24, #b45309)',
  obsidian: 'linear-gradient(135deg, #67e8f9, #3b82f6)'
};

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch theme palette"
        title="Switch theme"
        className="h-8 w-8 rounded-full border border-white/20 shadow-glass transition hover:scale-105"
        style={{ background: SWATCH[theme] }}
      />
      {open && (
        <ul
          role="listbox"
          aria-label="Theme palettes"
          className="glass-strong absolute right-0 z-20 mt-2 w-56 overflow-hidden p-1"
        >
          {THEMES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={t.id === theme}
                onClick={() => { setTheme(t.id); setOpen(false); }}
                className={
                  'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition ' +
                  (t.id === theme ? 'bg-white/15' : 'hover:bg-white/10')
                }
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-6 shrink-0 rounded-full border border-white/25 shadow"
                  style={{ background: SWATCH[t.id] }}
                />
                <span className="flex flex-col leading-tight">
                  <span className="font-medium text-theme-strong">{t.label}</span>
                  <span className="text-[10px] uppercase tracking-widest text-theme-muted">
                    {t.hint}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}