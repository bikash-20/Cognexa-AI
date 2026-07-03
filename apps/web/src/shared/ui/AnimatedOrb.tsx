import { useEffect, useRef } from 'react';

type Props = {
  size?: number;
  active?: boolean;
  className?: string;
};

/**
 * Pure-canvas animated orb — glass-morphic, palette-aware.
 * Reads --primary-glow-1/2/3 + --primary-halo from the active theme
 * on mount and re-reads on resize, so the orb always matches the
 * chosen palette (Amethyst, Rose Quartz, Mocha, Obsidian).
 */
export function AnimatedOrb({ size = 220, active = false, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number | null>(null);
  const t0 = useRef<number>(performance.now());

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    const root = document.documentElement;
    const rootStyle = getComputedStyle(root);

    function readRgba(varName: string, alpha = 1): string {
      const v = rootStyle.getPropertyValue(varName).trim();
      // Already an rgba()/rgb() string — pass through, with optional alpha multiplier.
      if (!v) return `rgba(255,255,255,${alpha})`;
      return v.includes('rgba') || v.includes('rgb') ? v : v;
    }

    const stops = [
      { c: readRgba('--primary-glow-1'), p: 0.0 },
      { c: readRgba('--primary-glow-2'), p: 0.45 },
      { c: readRgba('--primary-glow-3'), p: 1.0 }
    ];
    const haloColor = readRgba('--primary-halo');

    const draw = () => {
      const t = (performance.now() - t0.current) / 1000;
      ctx.clearRect(0, 0, size, size);

      // Halo
      const halo = ctx.createRadialGradient(
        size / 2, size / 2, size * 0.15,
        size / 2, size / 2, size * 0.55
      );
      halo.addColorStop(0, haloColor);
      halo.addColorStop(1, haloColor.replace(/[\d.]+\)$/, '0)'));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // Core radial blobs (3 layers, mixed by offset)
      const pulse = active ? 1.08 + Math.sin(t * 3) * 0.03 : 1.0 + Math.sin(t) * 0.04;
      const r = (size / 2) * 0.46 * pulse;
      const cx = size / 2 + Math.cos(t * 0.7) * 6;
      const cy = size / 2 + Math.sin(t * 0.9) * 6;

      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.05, cx, cy, r);
      for (const s of stops) g.addColorStop(s.p, s.c);

      ctx.beginPath();
      ctx.arc(size / 2, size / 2, r * 1.05, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // Inner highlight
      const hi = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.5, 1, cx - r * 0.4, cy - r * 0.5, r * 0.4);
      hi.addColorStop(0, 'rgba(255,255,255,0.55)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, r * 1.05, 0, Math.PI * 2);
      ctx.fillStyle = hi;
      ctx.fill();

      // Rotating ring
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(t * 0.3);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [size, active]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
