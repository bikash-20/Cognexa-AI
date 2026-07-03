import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { apiFetch } from '../../../shared/lib/api';
import {  ChatReplySchema, type ChatMessage } from '../../../shared/types/contracts';
import { z } from 'zod';
import { logWarn } from '../../../shared/lib/logger';

type SendInput = { history: ChatMessage[]; userName: string; sessionId?: string };

const ReplyEnvelope = z.object({ reply: ChatReplySchema });

/**
 * Owns: server state for the chat session.
 *   - Aborts in-flight requests when a newer one is fired.
 *   - Renders 4 explicit states: idle | loading | success | error.
 *   - Optimistically appends the user message and the assistant placeholder.
 */
export function useChat() {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  const send = useMutation({
    mutationFn: async ({ history, userName, sessionId }: SendInput) => {
      // Cancel any in-flight request before starting a new one.
      inFlight.current?.abort();
      const ac = new AbortController();
      inFlight.current = ac;

      const res = await apiFetch('/api/v1/chat', {
        method: 'POST',
        schema: ReplyEnvelope,
        signal: ac.signal,
        json: { user_name: userName, message: history[history.length - 1]?.content ?? '', history, session_id: sessionId }
      });
      return res;
    },
    onSuccess: (res, vars) => { void res; void vars; },
    onError: () => { /* muted — handled via status below */ }
  });

  // We wrap send to drive optimistic UI + status transitions explicitly.
  const submit = useCallback(async (userText: string, userName: string, sessionId?: string) => {
    setStatus('loading');
    setError(null);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
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

    const next = await send.mutateAsync({ history: [...messages, userMsg], userName, ...(sessionId ? { sessionId } : {}) });
    inFlight.current = null;

    if (!next.ok) {
      // Roll back placeholder on any failure.
      setMessages((prev) => prev.filter((m) => m.id !== placeholder.id));
      setStatus('error');
      setError(describe(next.error));
      logWarn('chat.error', { kind: next.error.kind });
      return;
    }

    setMessages((prev) => prev.map((m) => (m.id === placeholder.id ? next.ok ? next.data.reply.message : m : m)));
    setDegraded(Boolean(next.ok && next.data.reply.degraded));
    setStatus('success');
    qc.invalidateQueries({ queryKey: ['history'] });
  }, [messages, send, qc]);

  return { messages, status, error, degraded, submit, setMessages };
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
