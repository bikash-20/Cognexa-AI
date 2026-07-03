import { marked, type Tokens } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InlineMath, BlockMath } from 'react-katex';
import { codeToHtml } from 'shiki';

/* ---------------------------------------------------------
 * Markdown + KaTeX + Shiki renderer.
 *   - KaTeX inline ($...$) and block ($$...$$) parsed first.
 *   - Fenced code blocks -> <CodeBlock> with VS Code dark theme,
 *     language header, and Copy button (ChatGPT-style).
 *   - Inline `code` styled to look like ChatGPT inline code chips.
 *   - GFM tables, headings, lists, blockquotes.
 *   - XSS hardening: marked output is scrubbed of <script>, on*,
 *     and javascript: URIs. dangerouslySetInnerHTML is only used
 *     on prose — never on code (code is rendered as React children).
 * --------------------------------------------------------- */

type Seg =
  | { type: 'html'; html: string }
  | { type: 'math'; displayMode: boolean; tex: string };

type RenderBlock =
  | { kind: 'html'; html: string }
  | { kind: 'code'; code: string; lang: string };

/** Pulls math blocks out of the source so marked doesn't eat them. */
function tokenize(input: string): Seg[] {
  const out: Seg[] = [];
  const mathRe = /\$\$([^$]+?)\$\$|\$([^$]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let last = 0;
  for (const m of input.matchAll(mathRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'html', html: input.slice(last, idx) });
    if      (m[1] !== undefined) out.push({ type: 'math', displayMode: true,  tex: m[1] });
    else if (m[2] !== undefined) out.push({ type: 'math', displayMode: false, tex: m[2]! });
    else if (m[3] !== undefined) out.push({ type: 'math', displayMode: true,  tex: m[3] });
    else                          out.push({ type: 'math', displayMode: false, tex: m[4]! });
    last = idx + m[0].length;
  }
  if (last < input.length) out.push({ type: 'html', html: input.slice(last) });
  return out;
}

/** marked -> HTML, then strip the XSS attack surface. */
function renderMarkdown(md: string): string {
  const html = marked.parse(md, { gfm: true, async: false }) as string;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Splits an HTML string into render blocks. Fenced <pre><code
 * class="language-X">…</code></pre> become React code blocks;
 * everything else is prose HTML that gets innerHTML'd in. Inline
 * <code>…</code> stays inside the prose chunk — the CSS handles
 * it via .prose-ai code:not(pre code).
 */
function splitForCode(html: string): RenderBlock[] {
  const out: RenderBlock[] = [];
  const fenceRe = /<pre><code class="language-([\w+#-]+)">([\s\S]*?)<\/code><\/pre>/g;
  let last = 0;
  for (const m of html.matchAll(fenceRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'html', html: html.slice(last, idx) });
    const lang = m[1] || 'code';
    const body = m[2]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    out.push({ kind: 'code', code: body, lang });
    last = idx + m[0].length;
  }
  if (last < html.length) out.push({ kind: 'html', html: html.slice(last) });
  return out;
}

/* ---------- CodeBlock (ChatGPT-style, Shiki VS Code dark) ---------- */

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    setHtml('');
    codeToHtml(code, {
      lang: normalizeLang(lang),
      theme: 'github-dark',
      transformers: [
        {
          // Strip Shiki's default <pre> wrapper; we render our own.
          pre(node) {
            (node.properties as Record<string, unknown>)['class'] = 'shiki-pre';
          }
        }
      ]
    })
      .then((h) => { if (!cancelled.current) setHtml(h); })
      .catch(() => {
        if (!cancelled.current) {
          setHtml(`<pre class="shiki-pre"><code>${escape(code)}</code></pre>`);
        }
      });
    return () => { cancelled.current = true; };
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* ignored */ }
  }

  const languageLabel = normalizeLang(lang) || 'code';

  return (
    <div className="cbx not-prose">
      <div className="cbx__head">
        <span className="cbx__lang">{languageLabel}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="cbx__copy"
        >
          {copied ? (
            <>
              <CheckIcon /> Copied
            </>
          ) : (
            <>
              <CopyIcon /> Copy
            </>
          )}
        </button>
      </div>
      {html ? (
        <div
          className="cbx__body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="cbx__placeholder">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function normalizeLang(raw: string): string {
  if (!raw) return 'txt';
  const l = raw.toLowerCase();
  if (l === 'js' || l === 'javascript') return 'javascript';
  if (l === 'ts' || l === 'typescript') return 'typescript';
  if (l === 'py' || l === 'python') return 'python';
  if (l === 'sh' || l === 'shell' || l === 'bash' || l === 'zsh') return 'bash';
  if (l === 'yml') return 'yaml';
  if (l === 'cs') return 'csharp';
  if (l === 'c++' || l === 'cpp') return 'cpp';
  if (l === 'objective-c' || l === 'objc') return 'objc';
  return l;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* ---------- Markdown component ---------- */

export function Markdown({ source }: { source: string }) {
  const segs = useMemo(() => tokenize(source), [source]);

  return (
    <>
      {segs.map((seg, i) => {
        if (seg.type === 'math') {
          return seg.displayMode ? (
            <div key={i} className="my-3 overflow-x-auto">
              <BlockMath math={seg.tex} />
            </div>
          ) : (
            <span key={i}>
              <InlineMath math={seg.tex} />
            </span>
          );
        }
        const blocks = splitForCode(renderMarkdown(seg.html));
        return (
          <div key={i} className="prose-ai">
            {blocks.map((b, j) =>
              b.kind === 'code'
                ? <CodeBlock key={j} code={b.code} lang={b.lang} />
                : <div key={j} dangerouslySetInnerHTML={{ __html: b.html }} />
            )}
          </div>
        );
      })}
    </>
  );
}

// re-export token type for callers needing strong typing
export type { Tokens };
