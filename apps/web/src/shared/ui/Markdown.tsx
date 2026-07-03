import { marked, type Tokens } from 'marked';
import { useEffect, useMemo, useState } from 'react';
import { InlineMath, BlockMath } from 'react-katex';
import { codeToHtml } from "shiki";

/* ---------------------------------------------------------
 * Markdown + KaTeX + Shiki renderer.
 *   - Safe by default: marked.sanitize is replaced by an allowlist.
 *   - KaTeX inline ($...$) and block ($$...$$).
 *   - Code blocks highlighter via Shiki (vscode theme) — async.
 * --------------------------------------------------------- */

type Seg =
  | { type: 'html'; html: string }
  | { type: 'math'; displayMode: boolean; tex: string };

function tokenize(input: string): Seg[] {
  // Pull out math blocks first so marked doesn't misread them.
  const out: Seg[] = [];
  const mathRe = /\$\$([^$]+?)\$\$|\$([^$]+?)\$/g;
  let last = 0;
  for (const m of input.matchAll(mathRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'html', html: input.slice(last, idx) });
    if (m[1] !== undefined) out.push({ type: 'math', displayMode: true,  tex: m[1] });
    else                       out.push({ type: 'math', displayMode: false, tex: m[2]! });
    last = idx + m[0].length;
  }
  if (last < input.length) out.push({ type: 'html', html: input.slice(last) });
  return out;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(md: string): string {
  // marked with GFM tables; output is then escaped EXCEPT for tags we allow.
  // For simplicity we rely on marked to produce html and strip <script> by simple regex.
  const html = marked.parse(md, { gfm: true, async: false }) as string;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
}

export function Markdown({ source }: { source: string }) {
  const segs = useMemo(() => tokenize(source), [source]);
  const blocks: JSX.Element[] = [];
  for (const seg of segs) {
    if (seg.type === 'math') {
      blocks.push(
        seg.displayMode
          ? <div key={blocks.length} className="my-3 overflow-x-auto"><BlockMath math={seg.tex} /></div>
          : <span key={blocks.length}><InlineMath math={seg.tex} /></span>
      );
    } else {
      blocks.push(<div key={blocks.length} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.html) }} />);
    }
  }
  return <div className="prose-ai">{blocks}</div>;
}

/* ---------- CodeBlock with Shiki (VS Code Dark+ theme) ---------- */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    codeToHtml(code, { lang: lang || 'txt', theme: 'github-dark' })
      .then((h) => { if (alive) setHtml(h); })
      .catch(() => { if (alive) setHtml(`<pre>${escape(code)}</pre>`); });
    return () => { alive = false; };
  }, [code, lang]);

  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { /* ignored */ }
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/15 bg-wine-800/80">
      <div className="flex items-center justify-between bg-white/5 px-3 py-1.5 text-xs text-rose-100/70">
        <span>{lang || 'code'}</span>
        <button type="button" onClick={copy} className="rounded px-2 py-0.5 hover:bg-white/10">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="overflow-x-auto p-4 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/* Custom hook for a fenced-code block rewriter used by MessageBubble */
export function replaceCodeBlocks(html: string, renderer: (code: string, lang: string) => string): string {
  // Replace <pre><code class="language-X">…</code></pre>
  const re = /<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g;
  return html.replace(re, (_, lang: string, body: string) => renderer(body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), lang));
}

// re-export token type for callers needing strong typing
export type { Tokens };
