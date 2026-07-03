import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from './hooks/useChat';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { ChatHeader } from './ChatHeader';
import { useUserName } from '../../shared/lib/user';
import { v4 as uuid } from '../../shared/lib/uuid';

type BubbleAttachment = { filename: string; previewUrl?: string };

export function ChatWindow() {
  const { name } = useUserName();
  const { messages, status, error, degraded, submit } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  // message_id -> UI-only attachment chips to render above the bubble content.
  const [uiAttachments, setUiAttachments] = useState<Record<string, BubbleAttachment[]>>({});

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

  async function send(
    text: string,
    attachmentIds: string[] = [],
    attachmentMeta: { filename: string; previewUrl?: string }[] = []
  ) {
    if (!text.trim() && attachmentIds.length === 0) return;
    // Submit first so the optimistic message id exists, then attach chip meta to it.
    const messageId = crypto.randomUUID();
    if (attachmentMeta.length > 0) {
      setUiAttachments((prev) => ({ ...prev, [messageId]: attachmentMeta }));
    }
    await submit(messageId, text, name!, sessionId, attachmentIds);
  }

  function retry() {
    const last = messages[messages.length - 1];
    if (!last) return;
    send(last.content);
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <ChatHeader name={name} sessionId={sessionId} />
      {error && <ErrorBanner message={error} onRetry={retry} />}
      {degraded && (
        <div className="border-b border-amber-300/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-100">
          Running on a fallback provider — answers may be limited.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
          {messages.length === 0 && <EmptyState name={name} onPick={(q) => send(q)} />}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              attachments={m.role === 'user' ? uiAttachments[m.id] : undefined}
            />
          ))}
          {status === 'loading' && (
            <div className="glass flex w-fit items-center gap-1.5 self-start rounded-full px-3 py-2" aria-label="Thinking">
              <span className="h-1.5 w-1.5 animate-orb-pulse rounded-full bg-[color:var(--primary-glow-1)]" />
              <span className="h-1.5 w-1.5 animate-orb-pulse rounded-full bg-[color:var(--primary-glow-1)] [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-orb-pulse rounded-full bg-[color:var(--primary-glow-1)] [animation-delay:240ms]" />
            </div>
          )}
        </div>
      </div>

      <ChatInput onSend={(text, ids, meta) => send(text, ids, meta)} disabled={status === 'loading'} />
    </div>
  );
}