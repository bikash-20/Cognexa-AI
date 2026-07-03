import { z } from 'zod';
import { logWarn } from './logger';
import { AttachmentSummarySchema } from '../types/contracts';

/**
 * Defensive fetch wrapper:
 *  - JSON content-type always
 *  - Request cancellation via AbortController signal
 *  - Bounded exponential backoff on retryable failures (network, 5xx, 429)
 *  - Schema validation at the boundary — never trust untyped data in components
 *  - Always returns a structured ApiResult so the UI can render all four states
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export type ApiError =
  | { kind: 'network'; message: string }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'parse'; message: string }
  | { kind: 'canceled'; message: string };

interface FetchOpts<T> {
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  json?: unknown;
}

const MAX_RETRIES = 2;
const DEFAULT_BACKOFF = 400;
const DEFAULT_TIMEOUT = 28_000;

export async function apiFetch<T>(path: string, opts: FetchOpts<T>): Promise<ApiResult<T>> {
  const url = `${import.meta.env.VITE_API_BASE}${path}`;
  const retries = opts.retries ?? MAX_RETRIES;
  const baseBackoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const merge = mergeSignals([opts.signal, ac.signal]);
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : null,
        signal: merge
      });
      clearTimeout(timer);

      if (!res.ok) {
        const message = await safeText(res);
        if (isRetryable(res.status) && attempt < retries) {
          logWarn('api.retry', { path, status: res.status, attempt });
          await backoffWithJitter(baseBackoff, attempt);
          continue;
        }
        return { ok: false, error: { kind: 'http', status: res.status, message } };
      }

      const raw = await res.json().catch(() => null);
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: { kind: 'parse', message: parsed.error.message } };
      }
      return { ok: true, data: parsed.data };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        // If the caller's signal aborted (not our timeout), surface 'canceled'.
        if (opts.signal?.aborted) return { ok: false, error: { kind: 'canceled', message: 'aborted' } };
        if (attempt < retries) { await backoffWithJitter(baseBackoff, attempt); continue; }
        return { ok: false, error: { kind: 'network', message: 'timeout' } };
      }
      if (attempt < retries) { await backoffWithJitter(baseBackoff, attempt); continue; }
      return { ok: false, error: { kind: 'network', message: (err as Error).message } };
    }
  }
  return { ok: false, error: { kind: 'network', message: 'exhausted retries' } };
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter(Boolean) as AbortSignal[];
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0]!;
  const ac = new AbortController();
  for (const s of live) {
    if (s.aborted) { ac.abort(); break; }
    s.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

function backoffWithJitter(base: number, attempt: number): Promise<void> {
  const delay = Math.min(2000, base * 2 ** attempt) + Math.random() * 100;
  return new Promise<void>((r) => { setTimeout(r, delay); });;
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}


/* ---------- Streaming chat (Server-Sent Events) ---------- */

export type StreamEvent =
  | { type: 'session'; session_id: string }
  | { type: 'chunk'; delta: string }
  | { type: 'done'; message: unknown; layers_used: unknown; degraded?: boolean; provider?: string; attachments_used?: string[] | null }
  | { type: 'error'; detail: string };

export interface StreamChatCallbacks {
  onSession?: (sessionId: string) => void;
  onChunk: (delta: string) => void;
  onDone: (meta: { message: unknown; layers_used: unknown; degraded?: boolean; provider?: string; attachments_used?: string[] | null }) => void;
  onError?: (detail: string) => void;
}

export interface StreamChatHandle {
  abort: () => void;
}

/**
 * Opens a streaming POST to /api/v1/chat/stream and routes SSE events to the
 * supplied callbacks. The server emits four event names:
 *   - session  → session id created/confirmed on the server
 *   - chunk    → text delta (word groups, ~3 words each, ~30 ms apart)
 *   - done     → final metadata (full message, layers, provider, attachments)
 *   - error    → unrecoverable failure mid-stream (caller should still try fallback)
 *
 * Cancellation: caller invokes handle.abort() (or aborts the outer signal).
 */
export function streamChat(
  body: unknown,
  callbacks: StreamChatCallbacks,
  opts: { signal?: AbortSignal } = {}
): StreamChatHandle {
  const url = `${import.meta.env.VITE_API_BASE}/api/v1/chat/stream`;
  const ac = new AbortController();
  const merge = mergeSignals([opts.signal, ac.signal]);

  void (async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: merge
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      callbacks.onError?.((err as Error).message || 'network');
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await safeText(res).catch(() => res.statusText);
      callbacks.onError?.(detail || `http ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line. Process complete events.
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseEvent(rawEvent);
          if (!parsed) continue;
          dispatchStreamEvent(parsed, callbacks);
          if (ac.signal.aborted) return;
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      callbacks.onError?.((err as Error).message || 'stream interrupted');
    }
  })();

  return { abort: () => ac.abort() };
}

function parseSseEvent(raw: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data += line.slice(5).trim();
    }
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function dispatchStreamEvent(parsed: { event: string; data: unknown }, cb: StreamChatCallbacks): void {
  const payload = parsed.data as Record<string, unknown> | null;
  if (!payload) return;
  switch (parsed.event) {
    case 'session':
      cb.onSession?.(String(payload.session_id ?? ''));
      break;
    case 'chunk':
      if (typeof payload.delta === 'string') cb.onChunk(payload.delta);
      break;
    case 'done':
      cb.onDone({
        message: payload.message,
        layers_used: payload.layers_used,
        degraded: payload.degraded as boolean | undefined,
        provider: payload.provider as string | undefined,
        attachments_used: payload.attachments_used as string[] | null | undefined
      });
      break;
    case 'error':
      cb.onError?.(String(payload.detail ?? 'stream error'));
      break;
  }
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 400); } catch { return res.statusText; }
}


/* ---------- File upload (multipart) ---------- */

export const UploadResponseSchema = z.object({
  attachment: AttachmentSummarySchema,
  excerpt: z.string(),
  message: z.string()
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export type UploadError =
  | { kind: 'http' | 'parse' | 'network'; message: string }
  | { kind: 'too_large'; message: string };

export type UploadResult =
  | { ok: true; data: UploadResponse; localUrl: string }
  | { ok: false; error: UploadError };

const UPLOAD_TIMEOUT_MS = 90_000;   // OCR on a 40-page PDF can take a while
const FILE_SIZE_CAP = 25 * 1024 * 1024;

/**
 * Streams a PDF or image to /api/v1/uploads. Returns:
 *   - the server-side attachment id (saved into the next chat message)
 *   - a local object URL the UI can use to show a thumbnail/preview
 *   - the excerpt + friendly message the UI shows in the chat history
 */
export async function uploadFile(
  file: File,
  opts: { signal?: AbortSignal; onProgress?: (pct: number) => void } = {}
): Promise<UploadResult> {
  if (file.size > FILE_SIZE_CAP) {
    return {
      ok: false,
      error: {
        kind: 'too_large',
        message: `Max 25 MB — this file is ${(file.size / 1024 / 1024).toFixed(1)} MB`
      }
    };
  }
  const url = `${import.meta.env.VITE_API_BASE}/api/v1/uploads`;
  const form = new FormData();
  form.append('file', file);

  // XHR gives us real upload-progress events; fetch() does not.
  if (opts.onProgress) {
    return await uploadWithXhr(url, form, file, opts.signal, opts.onProgress);
  }
  return await uploadWithFetch(url, form, file, opts.signal);
}

function uploadWithFetch(
  url: string,
  form: FormData,
  file: File,
  signal: AbortSignal | undefined
): Promise<UploadResult> {
  const ac = new AbortController();
  const merge = mergeSignals([signal, ac.signal]);
  const timer = setTimeout(() => ac.abort(), UPLOAD_TIMEOUT_MS);
  return (async () => {
    try {
      const res = await fetch(url, { method: 'POST', body: form, signal: merge });
      clearTimeout(timer);
      if (!res.ok) {
        const message = await safeText(res);
        return { ok: false, error: { kind: 'http', message } };
      }
      const json = await res.json().catch(() => null);
      const parsed = UploadResponseSchema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, error: { kind: 'parse', message: parsed.error.message } };
      }
      return { ok: true, data: parsed.data, localUrl: URL.createObjectURL(file) };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        return { ok: false, error: { kind: 'network', message: 'timeout' } };
      }
      return { ok: false, error: { kind: 'network', message: (err as Error).message } };
    }
  })();
}

function uploadWithXhr(
  url: string,
  form: FormData,
  file: File,
  signal: AbortSignal | undefined,
  onProgress: (pct: number) => void
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    const timer = setTimeout(() => xhr.abort(), UPLOAD_TIMEOUT_MS);
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.onload = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        const json = JSON.parse(xhr.responseText);
        const parsed = UploadResponseSchema.safeParse(json);
        if (xhr.status >= 400) {
          const message =
            (json && typeof json === 'object' && 'error' in json && String((json as { error?: unknown }).error)) ||
            xhr.statusText;
          resolve({ ok: false, error: { kind: 'http', message } });
          return;
        }
        if (!parsed.success) {
          resolve({ ok: false, error: { kind: 'parse', message: parsed.error.message } });
          return;
        }
        resolve({ ok: true, data: parsed.data, localUrl: URL.createObjectURL(file) });
      } catch (e) {
        resolve({ ok: false, error: { kind: 'parse', message: (e as Error).message } });
      }
    };
    xhr.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: { kind: 'network', message: 'network' } });
    };
    xhr.onabort = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: { kind: 'network', message: signal?.aborted ? 'aborted' : 'timeout' } });
    };
    xhr.send(form);
  });
}
