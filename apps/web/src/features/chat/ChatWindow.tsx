import { useEffect, useMemo, useRef } from 'react';
import { useChat } from './hooks/useChat';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { ChatHeader } from './ChatHeader';
import { useUserName } from '../../shared/lib/user';
import { v4 as uuid } from '../../shared/lib/uuid';

export function ChatWindow() {
  const { name } = useUserName();
  // useChat থেকে layersUsed সহ ডিস্ট্রাকচার করা হলো
  const { messages, status, error, degraded, layersUsed, submit, setMessages } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionId = useMemo<string>(() => {
    const k = 'infamous.session_id.v1';
    const stored = localStorage.getItem(k);
    if (stored) return stored;
    const fresh = uuid();
    localStorage.setItem(k, fresh);
    return fresh;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  if (!name) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <a href="/" className="btn-primary">Set your name first</a>
      </div>
    );
  }

  async function send(text: string) {
    if (!text.trim()) return;
    await submit(text, name!, sessionId);
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <ChatHeader name={name} sessionId={sessionId} />
      {error && <ErrorBanner message={error} onRetry={() => messages.length > 0 && send(messages[messages.length - 1]!.content)} />}
      {degraded && (
        <div className="border-b border-amber-300/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-100">
          Running on a fallback provider — answers may be limited.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.length === 0 && <EmptyState name={name} onPick={(q) => send(q)} />}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {status === 'loading' && (
            <div className="flex items-center gap-2 self-start text-sm text-rose-100/70">
              <span className="h-2 w-2 animate-orb-pulse rounded-full bg-rose-300" />
              <span className="h-2 w-2 animate-orb-pulse rounded-full bg-rose-300 [animation-delay:120ms]" />
              <span className="h-2 w-2 animate-orb-pulse rounded-full bg-rose-300 [animation-delay:240ms]" />
              Thinking…
            </div>
          )}
        </div>
      </div>

      <ChatInput onSend={send} disabled={status === 'loading'} />
    </div>
  );
}