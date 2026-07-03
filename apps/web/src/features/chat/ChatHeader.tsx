import { Link } from 'react-router-dom';

export function ChatHeader({ name, sessionId }: { name: string; sessionId: string }) {
  return (
    <header className="glass-strong sticky top-0 z-10 flex items-center justify-between px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        <img src="/orb.jpg" alt="" className="h-8 w-8 rounded-full object-cover" />
        <div>
          <div className="font-display text-lg leading-tight text-rose-100">Infamous AI</div>
          <div className="text-xs text-rose-100/60">Chatting with {name}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden text-xs text-rose-100/40 sm:inline">session {sessionId.slice(0, 8)}</span>
        <Link to="/voice" className="btn-ghost text-sm">Voice</Link>
      </div>
    </header>
  );
}
