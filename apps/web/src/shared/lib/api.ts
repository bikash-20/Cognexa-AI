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
