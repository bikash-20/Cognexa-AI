import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatedOrb } from '../../shared/ui/AnimatedOrb';
import { ThemeSwitcher } from '../chat/ThemeSwitcher';
import { useUserName } from '../../shared/lib/user';
import { apiFetch } from '../../shared/lib/api';
import { z } from 'zod';

type Turn = { role: 'user' | 'assistant'; text: string; id: string };

// Match the real ChatReply contract from apps/api/app/schemas.py.
// Reply text lives at `message.content` — NOT a top-level `reply` field.
const ChatReplySchema = z.object({
  session_id: z.string(),
  message: z.object({ role: z.string(), content: z.string() }).passthrough(),
  layers_used: z.array(z.unknown()).optional(),
  degraded: z.boolean().optional(),
  provider: z.string().optional()
}).passthrough();

/* ---------- Helpers for Web Speech API ---------- */
type SR = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
  onerror: (e: unknown) => void;
  onend: () => void;
};

const TTS_TIMEOUT_MS = 12_000;

/**
 * Try the server's /api/v1/tts first (ElevenLabs → Cloudflare TTS).
 * On any failure (no keys, 4xx/5xx, network, timeout) fall back to the
 * browser's `speechSynthesis`. We never silently drop audio.
 */
async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${import.meta.env.VITE_API_BASE}/api/v1/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: null }),
      signal: ac.signal
    });
    clearTimeout(timer);
    const provider = res.headers.get('x-tts-provider') ?? 'silent';
    if (!res.ok) throw new Error(`tts http ${res.status}`);
    const blob = await res.blob();
    // If the server fell back to a silent WAV, skip playback entirely —
    // we still want to show the text transcript in the UI.
    if (provider === 'silent' || blob.size < 256) {
      speakBrowser(text);
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => { URL.revokeObjectURL(url); speakBrowser(text); };
    await audio.play().catch(() => speakBrowser(text));
  } catch {
    clearTimeout(timer);
    speakBrowser(text);
  }
}

function speakBrowser(text: string) {
  if (!('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); } catch { /* noop */ }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.pitch = 1.05;
  speechSynthesis.speak(u);
}

export function VoicePage() {
  const { name } = useUserName();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [liveText, setLiveText] = useState('');
  const [listening, setListening] = useState(false);
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const srRef = useRef<SR | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Mirror state into refs so async callbacks (rec.onend, rec.onresult,
  // ask()) can read the latest values without re-subscribing and without
  // triggering re-renders.
  const listeningRef = useRef(false);
  const replyingRef = useRef(false);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns, liveText]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => { replyingRef.current = replying; }, [replying]);

  // Clean up speech engines on unmount so audio doesn't leak across pages.
  useEffect(() => {
    return () => {
      try { srRef.current?.abort(); } catch { /* noop */ }
      try { speechSynthesis.cancel(); } catch { /* noop */ }
    };
  }, []);

  // Lazy Web Speech init (browsers vary).
  function ensureRecognizer(): SR | null {
    if (srRef.current) return srRef.current;
    const w = window as unknown as {
      SpeechRecognition?: new () => SR;
      webkitSpeechRecognition?: new () => SR;
    };
    const Cls = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Cls) {
      setError('This browser does not support speech recognition. Try Chrome or Edge.');
      return null;
    }
    const rec = new Cls();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    srRef.current = rec;
    return rec;
  }

  async function start() {
    setError(null);
    const rec = ensureRecognizer();
    if (!rec) return;
    // Permission prompt lives on first call to start(); reuse the recognizer
    // across turns and just call start() again on auto-end.
    let lastSent = '';
    rec.onresult = (e) => {
      let interim = '';
      let finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        if (r.isFinal) finalText += r[0].transcript;
        else           interim += r[0].transcript;
      }
      const shown = (finalText + (interim ? ` ${interim}` : '')).trim();
      setLiveText(shown);
      setTurns((prev) => {
        const copy = prev.slice();
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = {
          id: last?.id ?? crypto.randomUUID(),
          role: last?.role ?? 'user',
          text: shown
        };
        return copy;
      });
      // Send each new final chunk — multiple utterances per session are fine.
      if (finalText && finalText.trim() && finalText !== lastSent) {
        lastSent = finalText;
        void ask(finalText);
      }
    };
    rec.onerror = (e: unknown) => {
      const code = (e as { error?: string })?.error ?? 'unknown';
      // 'no-speech' and 'aborted' are normal lifecycle events, not errors.
      if (code === 'no-speech' || code === 'aborted') return;
      setError(`Microphone error (${code}). Check permissions.`);
      setListening(false);
    };
    rec.onend = () => {
      // Auto-restart while the user hasn't explicitly stopped, so silence
      // gaps (Chrome's default ~5s) don't kill the session.
      if (srRef.current && listeningRef.current) {
        try { srRef.current.start(); return; } catch { /* fall through */ }
      }
      setListening(false);
    };
    try {
      rec.start();
      setListening(true);
      listeningRef.current = true;
      setTurns((t) => [...t, { id: crypto.randomUUID(), role: 'user', text: '' }]);
    } catch (e) {
      setError(`Could not start microphone: ${(e as Error).message}`);
    }
  }

  function stop() {
    listeningRef.current = false;
    try { srRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  }

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || replyingRef.current) return;
    replyingRef.current = true;
    setReplying(true);
    setError(null);
    const res = await apiFetch('/api/v1/chat', {
      method: 'POST',
      schema: ChatReplySchema,
      json: { user_name: name ?? 'friend', message: trimmed, history: [], session_id: undefined }
    });
    if (!res.ok) {
      setError(
        res.error.kind === 'parse'
          ? 'Server returned an unexpected reply shape. Try again.'
          : res.error.kind === 'network'
          ? 'Network error talking to the server.'
          : `Failed to get a reply (${res.error.kind}).`
      );
      replyingRef.current = false;
      setReplying(false);
      return;
    }
    // ChatReply.message.content — not a top-level `reply` field.
    const reply = res.data.message?.content ?? '';
    if (!reply) {
      setError('Empty reply from server.');
      replyingRef.current = false;
      setReplying(false);
      return;
    }
    setTurns((t) => [...t, { id: crypto.randomUUID(), role: 'assistant', text: reply }]);
    setLiveText('');
    // Speak AFTER we render the transcript so the orb stays in 'replying'
    // state for the whole utterance, not just the fetch.
    try { await speak(reply); } catch { /* swallow — UI still shows text */ }
    replyingRef.current = false;
    setReplying(false);
  }

  return (
    <main className="flex h-[100dvh] flex-col">
      <header className="glass-strong flex items-center justify-between px-4 py-3 sm:px-6">
        <Link to="/chat" className="btn-ghost text-sm">Back to chat</Link>
        <span className="font-display text-theme-strong">Voice mode</span>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-theme-muted sm:inline">{name ?? ''}</span>
          <ThemeSwitcher />
        </div>
      </header>

      <div ref={scrollRef} className="relative flex flex-1 flex-col items-center justify-start overflow-y-auto px-4 pb-6 pt-10">
        <AnimatedOrb size={260} active={listening || replying} />
        <div className="mt-10 w-full max-w-md flex-1">
          <div className="glass-strong space-y-2 p-4">
            {turns.length === 0 && <p className="text-center text-sm text-theme-muted">Tap the mic and start talking.</p>}
            {turns.map((t) => (
              <div
                key={t.id}
                className={
                  'rounded-xl px-3 py-2 text-sm ' +
                  (t.role === 'user' ? 'bg-white/10 text-theme-strong' : 'glass text-theme-main')
                }
              >
                <div className="text-[10px] uppercase tracking-widest text-theme-muted">
                  {t.role === 'user' ? name ?? 'you' : 'cognexa'}
                </div>
                <div className="mt-1 leading-relaxed">{t.text || (t.role === 'user' ? '…' : '')}</div>
              </div>
            ))}
            {liveText && turns[turns.length - 1]?.text === '' && (
              <div className="rounded-xl bg-white/10 px-3 py-2 text-sm text-theme-strong">{liveText}</div>
            )}
            {replying && (
              <div className="glass rounded-xl px-3 py-2 text-sm text-theme-main">
                <span className="inline-block h-2 w-2 animate-orb-pulse rounded-full bg-[color:var(--primary-glow-1)]" />
                <span className="ml-2">listening… thinking…</span>
              </div>
            )}
          </div>
          {error && <div role="alert" className="mt-3 text-center text-xs text-theme-soft">{error}</div>}
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-white/10 bg-black/30 p-4 backdrop-blur-xl">
        {!listening
          ? <button type="button" onClick={start} className="btn-primary">Start talking</button>
          : <button type="button" onClick={stop} className="btn-ghost">Stop</button>}
      </div>
    </main>
  );
}
