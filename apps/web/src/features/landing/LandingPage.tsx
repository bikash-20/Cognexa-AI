import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatedOrb } from '../../shared/ui/AnimatedOrb';
import { setUserName } from '../../shared/lib/user';
import { logEvent } from '../../shared/lib/logger';

export function LandingPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  function start(mode: 'chat' | 'voice') {
    const trimmed = name.trim() || 'friend';
    setUserName(trimmed);
    logEvent('user.start', { mode });
    navigate(`/${mode}`, { replace: true });
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <AnimatedOrb size={240} active />

        <h1 className="mt-8 font-display text-4xl tracking-wide text-rose-100 sm:text-5xl">
          Infamous <span className="text-rose-400">AI</span>
        </h1>
        <p className="mt-2 text-rose-100/70">A glass-morphic assistant with memory.</p>

        <form
          className="glass-strong mx-auto mt-8 flex flex-col gap-3 p-6 text-left"
          onSubmit={(e) => { e.preventDefault(); start('chat'); }}
        >
          <label htmlFor="user-name" className="text-sm uppercase tracking-widest text-rose-200/80">
            What should I call you?
          </label>
          <input
            id="user-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="glass-input"
            placeholder="Your name"
            maxLength={60}
            aria-required="true"
          />

          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="submit" className="btn-primary">Start typing</button>
            <button type="button" className="btn-ghost" onClick={() => start('voice')}>
              Voice mode
            </button>
          </div>
          <p className="text-center text-xs text-rose-100/50">
            Your name is stored locally. No account needed.
          </p>
        </form>
      </div>
    </main>
  );
}
