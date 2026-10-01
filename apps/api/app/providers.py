"""Provider fallback chain with real SSE streaming + parallel race.

Order at the *chain* level (used as the race seed):
    OpenAI → Cloudflare → OpenRouter → Pollinations

Each provider is now an async generator that yields content deltas as they
arrive on the wire. The top-level entry point `generate_stream` races all
configured providers in parallel and yields chunks from whichever one
produces the first valid token; the others are cancelled. This collapses
TTFT to roughly the fastest provider's first-byte time, instead of the sum
of every provider's full response time.

The non-streaming `generate()` is preserved for callers that can't handle
SSE (the legacy `/api/v1/chat` route). Internally it just drains
`generate_stream()`.

OpenRouter free models are dynamically fetched from
https://openrouter.ai/api/v1/models on first use and cached 24h, so the
list self-rotates as OpenRouter changes their free lineup.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx

log = logging.getLogger("providers")


# ---------------------------------------------------------------------------
# Circuit breaker (per-provider, sliding 30s)
# ---------------------------------------------------------------------------
@dataclass
class Circuit:
    failures: list[float] = field(default_factory=list)
    open_until: float = 0.0

    def trip(self) -> None:
        self.failures.append(time.time())
        self.failures = [t for t in self.failures if time.time() - t < 30]
        if len(self.failures) >= 3:
            self.open_until = time.time() + 20

    def ok(self) -> bool:
        return time.time() >= self.open_until


_STATE: dict[str, Circuit] = {}


def _cb(name: str) -> Circuit:
    s = _STATE.get(name)
    if not s:
        s = Circuit()
        _STATE[name] = s
    return s


def json_event(event: str, **kw: Any) -> str:
    return f"{event} {json.dumps({k: v for k, v in kw.items() if v is not None}, default=str)}"


# ---------------------------------------------------------------------------
# OpenRouter dynamic free-model cache (24h TTL)
# ---------------------------------------------------------------------------
_OR_CACHE: dict[str, Any] = {"models": [], "fetched_at": 0.0}
_OR_TTL_S = 86_400


async def _or_free_models() -> list[str]:
    """Return the current list of free text chat models on OpenRouter.

    Fetches `https://openrouter.ai/api/v1/models` once per 24h, filters by
    `:free` suffix and text modality, caps at 8 to keep the cascade tight.
    Cache refresh also fires from `_openrouter_stream` on full exhaustion.
    """
    now = time.time()
    if _OR_CACHE["models"] and (now - _OR_CACHE["fetched_at"]) < _OR_TTL_S:
        return list(_OR_CACHE["models"])

    key = os.environ.get("OPENROUTER_API_KEY", "")
    headers = {"accept": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"

    try:
        async with httpx.AsyncClient(timeout=10) as cx:
            r = await cx.get("https://openrouter.ai/api/v1/models", headers=headers)
            r.raise_for_status()
            data = r.json().get("data", [])
    except Exception as e:
        log.warning(json_event("openrouter.cache.fail", error=type(e).__name__))
        # Stale cache is better than nothing.
        if _OR_CACHE["models"]:
            return list(_OR_CACHE["models"])
        # First-boot offline: ship an empty list and let _openrouter fail
        # fast so the race moves on to Pollinations.
        return []

    out: list[str] = []
    for m in data:
        mid = m.get("id", "")
        if not mid or not mid.endswith(":free"):
            continue
        arch = (m.get("architecture") or {})
        modality = (arch.get("modality") or "").lower()
        modalities = m.get("modalities") or []
        is_text = (
            "text" in modality
            or "text→text" in modality
            or "text" in (modalities if isinstance(modalities, list) else [])
        )
        if not is_text:
            continue
        out.append(mid)
        if len(out) >= 8:
            break

    if out:
        _OR_CACHE["models"] = out
        _OR_CACHE["fetched_at"] = now
        log.info(json_event("openrouter.cache.refresh", count=len(out)))
    return out


# Pollinations free models (small, curated; Pollinations rotates these too,
# but they keep the OpenAI-compatible endpoint stable). Order matters:
# fastest first. `openai-fast` is reliably the quickest on the free tier.
_POLLINATIONS_MODELS = ["openai-fast", "openai", "qwen-coder", "mistral", "llama"]


# ---------------------------------------------------------------------------
# Streaming provider callables (async generators)
# ---------------------------------------------------------------------------
async def _openai_stream(
    system: str, user: str, *, timeout: float
) -> AsyncIterator[str]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("no-openai-key")
    cb = _cb("openai")
    if not cb.ok():
        raise RuntimeError("circuit-open")

    sse_timeout = httpx.Timeout(connect=10.0, read=timeout, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=sse_timeout) as cx:
        async with cx.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            headers={
                "authorization": f"Bearer {key}",
                "content-type": "application/json",
                "accept": "text/event-stream",
            },
            json={
                "model": "gpt-4o-mini",
                "stream": True,
                "temperature": 0.4,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        ) as r:
            if r.status_code >= 400:
                body = (await r.aread())[:300].decode("utf-8", errors="replace")
                log.warning(json_event("openai.http", status=r.status_code, body=body))
                raise RuntimeError(f"openai http {r.status_code}")
            async for line in r.aiter_lines():
                if not line:
                    continue
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    cb.failures.clear()
                    return
                try:
                    obj = json.loads(payload)
                    ch = (obj.get("choices") or [{}])[0] or {}
                    d = ch.get("delta") or {}
                    delta = (
                        d.get("content")
                        or d.get("reasoning")
                        or ch.get("message", {}).get("content")
                        or ch.get("text")
                        or ""
                    )
                except Exception:
                    continue
                if delta:
                    yield delta
            cb.failures.clear()


async def _cloudflare_stream(
    system: str, user: str, *, timeout: float
) -> AsyncIterator[str]:
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not (acct and tok):
        raise RuntimeError("no-cf-key")
    cb = _cb("cloudflare")
    if not cb.ok():
        raise RuntimeError("circuit-open")

    async with httpx.AsyncClient(timeout=timeout) as cx:
        async with cx.stream(
            "POST",
            f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/meta/llama-3.1-8b-instruct",
            headers={
                "authorization": f"Bearer {tok}",
                "content-type": "application/json",
            },
            json={
                "stream": True,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        ) as r:
            if r.status_code >= 400:
                raise RuntimeError(f"cloudflare http {r.status_code}")
            async for line in r.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    cb.failures.clear()
                    return
                try:
                    obj = json.loads(payload)
                    ch = (obj.get("choices") or [{}])[0] or {}
                    d = ch.get("delta") or {}
                    delta = (
                        obj.get("response")
                        or d.get("content")
                        or d.get("reasoning")
                        or ch.get("message", {}).get("content")
                        or ch.get("text")
                        or ""
                    )
                except Exception:
                    continue
                if delta:
                    yield delta
            cb.failures.clear()


async def _openrouter_stream(
    system: str, user: str, *, timeout: float
) -> AsyncIterator[str]:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("no-openrouter-key")
    cb = _cb("openrouter")
    if not cb.ok():
        raise RuntimeError("circuit-open")

    models = await _or_free_models()
    if not models:
        # Force a cache miss next time.
        _OR_CACHE["fetched_at"] = 0.0
        raise RuntimeError("no-openrouter-free-models")

    headers = {
        "authorization": f"Bearer {key}",
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    or_timeout = httpx.Timeout(connect=10.0, read=timeout, write=10.0, pool=10.0)

    last_err: Exception | None = None
    for model in models:
        try:
            async with httpx.AsyncClient(timeout=or_timeout) as cx:
                async with cx.stream(
                    "POST",
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={**headers, "x-openrouter-model": model},
                    json={
                        "model": model,
                        "stream": True,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                    },
                ) as r:
                    if r.status_code >= 400:
                        body = (await r.aread())[:200].decode("utf-8", errors="replace")
                        log.warning(
                            json_event(
                                "openrouter.model.fail",
                                model=model,
                                status=r.status_code,
                                body=body,
                            )
                        )
                        last_err = RuntimeError(f"http {r.status_code}")
                        continue
                    saw_any = False
                    async for line in r.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        payload = line[6:]
                        if payload.strip() == "[DONE]":
                            cb.failures.clear()
                            if saw_any:
                                log.info(json_event("openrouter.model.success", model=model))
                                return
                            # Empty stream — try next model.
                            break
                        try:
                            obj = json.loads(payload)
                            ch = (obj.get("choices") or [{}])[0] or {}
                            d = ch.get("delta") or {}
                            delta = (
                                d.get("content")
                                or d.get("reasoning")
                                or ch.get("message", {}).get("content")
                                or ch.get("text")
                                or ""
                            )
                        except Exception:
                            continue
                        if delta:
                            saw_any = True
                            yield delta
                    if saw_any:
                        return
        except Exception as e:
            last_err = e
            log.warning(json_event("openrouter.model.fail", model=model, error=type(e).__name__))
            continue

    # All models exhausted — bust the cache so the next call re-fetches.
    _OR_CACHE["fetched_at"] = 0.0
    raise RuntimeError(
        f"all openrouter models failed: {type(last_err).__name__ if last_err else 'unknown'}"
    )


async def _pollinations_stream(
    system: str, user: str, *, timeout: float
) -> AsyncIterator[str]:
    """Free; no API key. Used as the last-resort fallback in the race."""
    cb = _cb("pollinations")
    if not cb.ok():
        raise RuntimeError("circuit-open")

    headers = {
        "accept": "text/event-stream",
        "content-type": "application/json",
        "user-agent": "cognexa-ai/1.0",
    }

    # Keep prompts compact for the free tier.
    sys_short = system[-1800:] if len(system) > 1800 else system
    user_short = user[-1800:] if len(user) > 1800 else user

    last_err: Exception | None = None
    # SSE-friendly timeout: connect fast, but each individual chunk read can
    # take longer because free-tier providers trickle. Total deadline still
    # bounded by `timeout`.
    # Use a per-model read budget so the inner fallback chain completes
    # quickly when no model is responding. We allow at least 8s per model so
    # the first-chunk latency on slow free-tier inference (Toktits in our
    # observations) doesn't trip the cascade prematurely.
    per_model_budget = max(8.0, timeout / 2)
    poll_timeout = httpx.Timeout(connect=5.0, read=per_model_budget, write=5.0, pool=5.0)
    for model in _POLLINATIONS_MODELS:
        try:
            async with httpx.AsyncClient(timeout=poll_timeout) as cx:
                async with cx.stream(
                    "POST",
                    "https://text.pollinations.ai/openai",
                    headers=headers,
                    json={
                        "model": model,
                        "stream": True,
                        "private": True,
                        "seed": 42,
                        "messages": [
                            {"role": "system", "content": sys_short},
                            {"role": "user", "content": user_short},
                        ],
                    },
                ) as r:
                    if r.status_code >= 400:
                        body = (await r.aread())[:200].decode("utf-8", errors="replace")
                        log.warning(
                            json_event(
                                "pollinations.model.fail",
                                model=model,
                                status=r.status_code,
                                body=body,
                            )
                        )
                        last_err = RuntimeError(f"http {r.status_code}")
                        continue
                    saw_any = False
                    async for line in r.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        payload = line[6:]
                        if payload.strip() == "[DONE]":
                            if saw_any:
                                cb.failures.clear()
                                log.info(json_event("pollinations.model.ok", model=model))
                                return
                            break
                        try:
                            obj = json.loads(payload)
                            choices = obj.get("choices") or [{}]
                            ch = choices[0] if choices else {}
                            delta = ch.get("delta") or {}
                            msg = (
                                delta.get("content")
                                or delta.get("reasoning")
                                or ch.get("message", {}).get("content")
                                or ch.get("text")
                                or ""
                            )
                        except Exception:
                            continue
                        if msg:
                            saw_any = True
                            yield msg
                    if saw_any:
                        return
        except Exception as e:
            last_err = e
            log.warning(json_event("pollinations.model.fail", model=model, error=type(e).__name__))
            # On read timeout / connection drop, try the next model.
            continue

    cb.trip()
    raise RuntimeError(
        f"all pollinations models failed: {type(last_err).__name__ if last_err else 'unknown'}"
    )


# ---------------------------------------------------------------------------
# Chain table (used by race seed + non-streaming fallback)
# ---------------------------------------------------------------------------
_CHAIN: list[tuple[str, Callable[..., AsyncIterator[str]]]] = [
    ("openai", _openai_stream),
    ("cloudflare", _cloudflare_stream),
    ("openrouter", _openrouter_stream),
    ("pollinations", _pollinations_stream),
]


def _eligible_providers() -> list[tuple[str, Callable[..., AsyncIterator[str]]]]:
    """Skip providers with open circuits so we don't waste tokens racing them.

    An open-circuit provider raises before yielding anything, so racing it
    is safe but wastes a task. Filter here for cleanliness + observability.
    """
    out: list[tuple[str, Callable[..., AsyncIterator[str]]]] = []
    for name, fn in _CHAIN:
        if _cb(name).ok():
            out.append((name, fn))
        else:
            log.debug(json_event("provider.skipped_circuit_open", name=name))
    return out or list(_CHAIN)  # never empty — last resort always tries


# ---------------------------------------------------------------------------
# Parallel race entry point (real streaming)
# ---------------------------------------------------------------------------
async def generate_stream(system: str, user: str, *, timeout: float) -> AsyncIterator[tuple[str, str]]:
    """Race every eligible provider in parallel. Yield (delta, provider_name).

    `provider_name` is constant across all yielded tuples for a single call.
    The first provider to emit a real chunk wins; the others are cancelled.
    On full exhaustion, yields a single synthetic (delta, "degraded") pair
    so the caller's `async for` loop still terminates cleanly.

    Race algorithm: every provider runs as a background task that pushes
    either a string delta or a `None` poison pill into a SHARED queue,
    tagged with the provider name. The consumer awaits the next item. The
    first non-None string locks in the winner; the consumer then drains
    the queue, while loser tasks get cancelled. Once any provider finishes
    cleanly (None) we increment a counter; if all providers finish without
    ever emitting a real delta, we yield the degraded fallback.
    """
    providers = _eligible_providers()

    # Shared FIFO. Items are (provider_name, delta_or_None).
    q: asyncio.Queue[tuple[str, str | None]] = asyncio.Queue()

    async def pump(name: str, fn: Callable[..., AsyncIterator[str]]) -> None:
        try:
            async for delta in fn(system, user, timeout=timeout):
                await q.put((name, delta))
        except Exception as e:
            log.warning(json_event("provider.fail", name=name, error=type(e).__name__))
            try:
                _cb(name).trip()
            except Exception:
                pass
        finally:
            await q.put((name, None))  # poison pill

    tasks: list[asyncio.Task[None]] = [
        asyncio.create_task(pump(n, f), name=f"prov:{n}") for n, f in providers
    ]

    winner: str | None = None
    finished = 0
    total = len(providers)
    # Global deadline: if no provider has emitted a real chunk within
    # `timeout` seconds of the race starting, we abandon and yield the
    # degraded fallback so the caller's `async for` loop terminates
    # promptly instead of waiting on every pump to deliver its poison pill.
    deadline = asyncio.get_event_loop().time() + timeout

    try:
        while finished < total:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                # Out of time. Stop the pumps and let the caller degrade.
                for t in tasks:
                    if not t.done():
                        t.cancel()
                break
            try:
                name, item = await asyncio.wait_for(q.get(), timeout=remaining)
            except asyncio.TimeoutError:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                break
            if item is None:
                finished += 1
                continue
            # First real chunk — lock the winner, cancel losers.
            if winner is None:
                winner = name
                for t in tasks:
                    if not t.done():
                        t.cancel()
            yield (item, winner)
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    if winner is None:
        log.error(json_event("provider.exhausted"))
        yield (
            "I'm having trouble reaching my reasoning providers right now. "
            "Your message was saved — please try again in a moment.",
            "degraded",
        )


# ---------------------------------------------------------------------------
# Non-streaming facade (for /api/v1/chat)
# ---------------------------------------------------------------------------
async def generate(system: str, user: str, *, timeout: float) -> tuple[str, str]:
    """Drain generate_stream() into a single string + provider name."""
    buf: list[str] = []
    provider = "unknown"
    async for delta, prov in generate_stream(system, user, timeout=timeout):
        buf.append(delta)
        provider = prov
    text = "".join(buf)
    if provider == "degraded":
        return (text, "degraded")
    if provider != "unknown":
        log.info(json_event("provider.used", name=provider, chars=len(text)))
    return (text, provider)