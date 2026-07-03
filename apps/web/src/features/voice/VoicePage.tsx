import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatedOrb } from '../../shared/ui/AnimatedOrb';
import { ThemeSwitcher } from '../chat/ThemeSwitcher';
import { useUserName } from '../../shared/lib/user';
import { apiFetch } from '../../shared/lib/api';
import { z } from 'zod';

type Turn = { role: 'user' | 'assistant'; text: string; id: string };

const TranscriptSchema = z.object({ transcript: z.string(), reply: z.string() });

/* ---------- Helpers for Web Speech API ---------- */
type SR = {
  start: () => void;
  stop: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
  onerror: (e: unknown) => void;
  onend: () => void;
};

function speak(text: string) {
  if (!('speechSynthesis' in window)) return;
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

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns, liveText]);

  // Lazy Web Speech init (browsers vary).
  function ensureRecognizer(): SR | null {
    if (srRef.current) return srRef.current;
    const w = window as unknown as {
      SpeechRecognition?: new () => SR;
      webkitSpeechRecognition?: new () => SR;
    };
    const Cls = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Cls) { setError('This browser does not support speech recognition. Try Chrome/Edge.'); return null; }
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
    setTurns((t) => [...t, { id: crypto.randomUUID(), role: 'user', text: '' }]);
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
        copy[copy.length - 1] = { ...(copy[copy.length - 1] ?? { id: 'x', role: 'user', text: '' }), text: shown };
        return copy;
      });
      // Send when final result present.
      if (finalText && finalText !== lastSent) {
        lastSent = finalText;
        void ask(finalText);
      }
    };
    rec.onerror = () => setError('Microphone error. Check permissions.');
    rec.onend   = () => setListening(false);
    try { rec.start(); setListening(true); } catch { setError('Could not start microphone.'); }
  }

  function stop() {
    srRef.current?.stop();
    setListening(false);
  }

  async function ask(text: string) {
    if (!text.trim() || replying) return;
    setReplying(true);
    const res = await apiFetch('/api/v1/chat', {
      method: 'POST',
      schema: TranscriptSchema,
      json: { user_name: name ?? 'friend', message: text, history: [], session_id: undefined }
    });
    if (!res.ok) {
      setError('Failed to get a reply.');
      setReplying(false);
      return;
    }
    const reply = res.data.reply;
    setTurns((t) => [...t, { id: crypto.randomUUID(), role: 'assistant', text: reply }]);
    setLiveText('');
    setReplying(false);
    speak(reply);
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
