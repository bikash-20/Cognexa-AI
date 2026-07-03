import type { Config } from 'tailwindcss';

/**
 * Palette derived from the Infamous Beauty brand reference.
 * Rose / pink dominant with deep wine-toned neutrals — supports
 * light & dark surfaces for the glass-morphic UI.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        rose: {
          50:  '#fff1f6',
          100: '#ffe0ec',
          200: '#ffc1d9',
          300: '#ff9fc1',
          400: '#f97aac',
          500: '#ed4f92',
          600: '#d62f78',
          700: '#ad1f5f',
          800: '#7a1742',
          900: '#4a0e28'
        },
        wine: {
          50:  '#fbeef2',
          100: '#efd3dc',
          200: '#c69aa6',
          300: '#8c5764',
          400: '#5a2c3a',
          500: '#3a1622',
          600: '#260d16',
          700: '#1a0a12',
          800: '#12070d',
          900: '#0a0408'
        }
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['"Inter"', 'system-ui', 'sans-serif']
      },
      backdropBlur: { xs: '2px' },
      boxShadow: {
        glass: '0 8px 32px 0 rgba(149, 26, 60, 0.18)',
        'glass-lg': '0 16px 48px 0 rgba(149, 26, 60, 0.28)'
      },
      animation: {
        'orb-pulse': 'orbPulse 4s ease-in-out infinite',
        'orb-spin':  'orbSpin 12s linear infinite',
        'fade-in':   'fadeIn 0.3s ease-out'
      },
      keyframes: {
        orbPulse: { '0%,100%': { transform: 'scale(1)', filter: 'brightness(1)' }, '50%': { transform: 'scale(1.06)', filter: 'brightness(1.15)' } },
        orbSpin:  { to: { transform: 'rotate(360deg)' } },
        fadeIn:   { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } }
      }
    }
  },
  plugins: []
};
export default config;
