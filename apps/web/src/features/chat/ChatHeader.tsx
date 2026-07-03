import { Link } from 'react-router-dom';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useState } from 'react';

export function ChatHeader({ name, sessionId }: { name: string; sessionId: string }) {
  const [showSession, setShowSession] = useState(false);
  return (
    <header className="glass-strong sticky top-0 z-10 flex items-center justify-between px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        <img src="/orb.jpg" alt="" className="h-8 w-8 rounded-full object-cover" />
        <div>
          <div className="font-display text-lg leading-tight text-theme-strong">COGNEXA AI</div>
          <div className="text-xs text-theme-muted">by Bikash Talukder · chatting with {name}</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowSession((s) => !s)}
          aria-label="Show session id"
          title={showSession ? 'Hide session id' : 'Show session id'}
          className="grid h-8 w-8 place-items-center rounded-lg text-theme-muted transition hover:bg-white/10 hover:text-theme-strong"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {showSession && (
          <span className="rounded-md bg-black/30 px-2 py-1 font-mono text-[10px] text-theme-dim">
            {sessionId.slice(0, 8)}
          </span>
        )}
        <ThemeSwitcher />
        <Link
          to="/voice"
          aria-label="Voice mode"
          title="Voice mode"
          className="grid h-8 w-8 place-items-center rounded-lg text-theme-muted transition hover:bg-white/10 hover:text-theme-strong"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8"  y1="23" x2="16" y2="23" />
          </svg>
        </Link>
      </div>
    </header>
  );
}
