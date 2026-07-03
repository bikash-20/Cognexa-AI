import { AnimatedOrb } from '../../shared/ui/AnimatedOrb';

const STARTERS = [
  'Explain the chain rule in calculus with a worked example',
  'Write a brute-force two-sum algorithm in Python',
  'Summarize the Krebs cycle step by step',
  "What's the derivative of \\( e^{x^2} \\)? Use $$ \\frac{d}{dx}e^{x^2}=2xe^{x^2} $$ to show it"
];

export function EmptyState({ name, onPick }: { name: string; onPick: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <AnimatedOrb size={160} />
      <div className="text-center">
        <h2 className="font-display text-2xl text-rose-100">Hi {name} — what shall we explore?</h2>
        <p className="mt-1 text-sm text-rose-100/70">Pick one to start, or type your own below.</p>
      </div>
      <ul className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {STARTERS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="glass w-full p-3 text-left text-sm transition hover:bg-white/10"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
