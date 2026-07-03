import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { apiFetch, streamChat } from '../../../shared/lib/api';
import {  ChatReplySchema, type ChatMessage } from '../../../shared/types/contracts';
import { logWarn } from '../../../shared/lib/logger';

const ReplyEnvelope = ChatReplySchema;

/** Coalesces rapid chunk updates into one render per animation frame. */
function makeStreamFlusher(
  placeholderId: string,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
): { push: (delta: string) => void; finalize: (full: string) => void; abort: () => void } {
  let pending = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const chunk = pending;
    pending = '';
    setMessages((prev) => prev.map((m) => (m.id === placeholderId ? { ...m, content: m.content + chunk } : m)));
  };
  return {
    push(delta: string) {
      pending += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    finalize(full: string) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      setMessages((prev) => prev.map((m) => (m.id === placeholderId ? { ...m, content: full } : m)));
    },
    abort() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
  };
}

/**
 * Owns: server state for the chat session.
 *   - Aborts in-flight requests when a newer one is fired.
 *   - Renders 4 explicit states: idle | loading | success | error.
 *   - Optimistically appends the user message and the assistant placeholder.
 *   - Streams the assistant reply token-by-token via SSE.
 */
export function useChat() {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [layersUsed, setLayersUsed] = useState<{ name: string; weight: number }[]>([]);
  const inFlight = useRef<AbortController | null>(null);

  // We wrap send to drive optimistic UI + status transitions explicitly.
  const submit = useCallback(async (
    messageId: string,
    userText: string,
    userName: string,
    sessionId?: string,
    attachmentIds: string[] = []
  ) => {
    setStatus('loading');
    setError(null);
    setStreaming(true);

    const userMsg: ChatMessage = {
      id: messageId || crypto.randomUUID(),
      role: 'user',
      content: userText,
      created_at: new Date().toISOString()
    };
    const placeholder: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
      layer: 'simple'
    };
    setMessages((prev) => [...prev, userMsg, placeholder]);

    const body: Record<string, unknown> = {
      user_name: userName,
      message: userText,
      history: [...messages, userMsg]
    };
    if (sessionId) body.session_id = sessionId;
    if (attachmentIds.length > 0) body.attachment_ids = attachmentIds;

    // Cancel any prior in-flight stream before opening a new one.
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;

    const flusher = makeStreamFlusher(placeholder.id, setMessages);
    let assembled = '';
    let streamFailed = false;
    let streamErrDetail = '';
    let streamDone = false;

    const donePromise = new Promise<void>((resolve) => {
      const finish = () => { streamDone = true; resolve(); };
      const handle = streamChat(
        body,
        {
          onSession: () => { /* could cache sessionId here if needed */ },
          onChunk: (delta) => {
            assembled += delta;
            flusher.push(delta);
          },
          onDone: (meta) => {
            flusher.finalize(assembled);
            if (meta.message) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === placeholder.id
                    ? ({ ...(meta.message as ChatMessage), content: assembled || (meta.message as ChatMessage).content } as ChatMessage)
                    : m
                )
              );
            }
            setDegraded(Boolean(meta.degraded));
            setLayersUsed(
              Array.isArray(meta.layers_used)
                ? (meta.layers_used as { name: string; weight: number }[])
                : []
            );
            setStatus('success');
            setStreaming(false);
            qc.invalidateQueries({ queryKey: ['history'] });
            finish();
          },
          onError: (detail) => {
            streamFailed = true;
            streamErrDetail = detail;
            finish();
          }
        },
        { signal: ac.signal }
      );
      // If ac is aborted externally, surface that as a failure too.
      ac.signal.addEventListener('abort', () => {
        handle.abort();
        flusher.abort();
        if (!streamDone) {
          streamFailed = true;
          streamErrDetail = 'canceled';
          finish();
        }
      }, { once: true });
    });

    await donePromise;
    inFlight.current = null;
    flusher.abort();

    if (streamFailed) {
      setMessages((prev) => prev.filter((m) => m.id !== placeholder.id));
      const fallback = await apiFetch('/api/v1/chat', {
        method: 'POST',
        schema: ReplyEnvelope,
        signal: ac.signal,
        json: body
      });
      if (!fallback.ok) {
        setStatus('error');
        setError(streamErrDetail || describe(fallback.error));
        setStreaming(false);
        logWarn('chat.error', { kind: fallback.error.kind });
        return;
      }
      setMessages((prev) => [...prev, fallback.data.message]);
      setDegraded(Boolean(fallback.data.degraded));
      setLayersUsed(fallback.data.layers_used || []);
      setStatus('success');
      setStreaming(false);
      qc.invalidateQueries({ queryKey: ['history'] });
    }
  }, [messages, qc]);

  return { messages, status, error, degraded, layersUsed, submit, setMessages, streaming };
}

function describe(e: { kind: string; message: string }): string {
  switch (e.kind) {
    case 'network': return 'Network unreachable. Check your connection.';
    case 'http':    return 'The AI service returned an error.';
    case 'parse':   return 'Unexpected response from server.';
    case 'canceled':return 'Request canceled.';
    default:        return 'Something went wrong.';
  }
}
