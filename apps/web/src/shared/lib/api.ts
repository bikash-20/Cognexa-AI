import { z } from 'zod';
import { logWarn } from './logger';

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

