import { AnimatedOrb } from '../../shared/ui/AnimatedOrb';
import { Markdown } from '../../shared/ui/Markdown';

type Starter = {
  prompt: string;
  title: string;
  lang: string;
  lineHint: string;
};

/* Starter cards — `prompt` is what we send to the model.
 * `title` / `lang` / `lineHint` are purely cosmetic, emulating a code editor card. */
const STARTERS: Starter[] = [
  {
    title: 'chain-rule.ts',
    lang: 'typescript',
    lineHint: 'L1',
    prompt: 'Explain the chain rule in calculus with a worked example'
  },
  {
    title: 'two-sum.py',
    lang: 'python',
    lineHint: 'L3',
    prompt: 'Write a brute-force two-sum algorithm in Python'
  },
  {
    title: 'krebs-cycle.md',
    lang: 'markdown',
    lineHint: '§ metabolism',
    prompt: 'Summarize the Krebs cycle step by step'
  },
  {
    title: 'derivative.tex',
    lang: 'latex',
    lineHint: 'L7',
    prompt: "Differentiate \\( e^{x^2} \\) using the chain rule. Show steps and write the result as $$ \\frac{d}{dx}\\,e^{x^2}=2x\\,e^{x^2} $$"
  }
];

const LANG_DOT: Record<string, string> = {
  typescript: '#3178c6',
  python:     '#3776ab',
  markdown:   '#a78bfa',
  latex:      '#06b6d4'
};

function FileTab({ s }: { s: Starter }) {
  const color = LANG_DOT[s.lang] ?? '#9ca3af';
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-theme-dim"
      title={s.lang}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {s.title}
    </span>
  );
}

export function EmptyState({ name, onPick }: { name: string; onPick: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <AnimatedOrb size={160} />

      {/* Terminal-style welcome banner */}
      <div className="glass-strong w-full max-w-2xl overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 bg-black/30 px-3 py-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 font-mono text-[11px] text-theme-dim">~/cognexa — chat.tsx</span>
        </div>
        <div className="px-4 py-3 font-mono text-[13px] leading-relaxed">
          <span className="text-[color:var(--primary-glow-1)]">$</span>{' '}
          <span className="text-theme-soft">greet </span>
          <span className="text-[color:var(--primary-glow-2)]">--user</span>{' '}
          <span className="text-theme-strong">{name}</span>
          <div className="mt-1 text-theme-strong">Hi {name} — what shall we explore?</div>
          <div className="mt-1 text-theme-muted">
            <span className="text-[color:var(--primary-glow-1)]">›</span> Pick a starter below, or type your own prompt.
          </div>
        </div>
      </div>

      {/* File-tab cards in a 2x2 grid */}
      <ul className="grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <li key={s.prompt}>
            <button
              type="button"
              onClick={() => onPick(s.prompt)}
              className="glass-strong group flex w-full flex-col items-stretch overflow-hidden text-left transition hover:bg-white/10"
            >
              {/* Tab strip — looks like a VS Code editor tab */}
              <div className="flex items-center justify-between border-b border-white/10 bg-black/30 px-2.5 py-1.5">
                <FileTab s={s} />
                <span className="font-mono text-[10px] text-theme-dim">{s.lineHint}</span>
              </div>
              {/* Body — math-aware rendering so $$/\] tokenize correctly */}
              <div className="px-3 py-2.5 text-sm leading-snug text-theme-main prose-ai">
                <Markdown source={s.prompt} />
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
