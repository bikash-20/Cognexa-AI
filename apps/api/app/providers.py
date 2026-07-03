"""Provider fallback chain: OpenAI → Cloudflare → OpenRouter → Pollinations."""
from __future__ import annotations
import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
import httpx
import logging

log = logging.getLogger("providers")


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


async def _openai(system: str, user: str, *, timeout: float) -> str:
    import os
    key = os.environ.get("OPENAI_API_KEY")
    if not key: raise RuntimeError("no-openai-key")
    cb = _cb("openai")
    if not cb.ok(): raise RuntimeError("circuit-open")
    async with httpx.AsyncClient(timeout=timeout) as cx:
        r = await cx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"authorization": f"Bearer {key}"},
            json={"model": "gpt-4o-mini", "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0.4},
        )
        r.raise_for_status()
        cb.failures.clear()
        return r.json()["choices"][0]["message"]["content"]


async def _cloudflare(system: str, user: str, *, timeout: float) -> str:
    import os
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not (acct and tok): raise RuntimeError("no-cf-key")
    cb = _cb("cloudflare")
    if not cb.ok(): raise RuntimeError("circuit-open")
    async with httpx.AsyncClient(timeout=timeout) as cx:
        r = await cx.post(
            f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/meta/llama-3.1-8b-instruct",
            headers={"authorization": f"Bearer {tok}"},
            json={"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
        )
        r.raise_for_status()
        cb.failures.clear()
        return r.json()["result"]["response"]


_OR_FREE_MODELS = [
    # Curated list of currently-free chat models on OpenRouter.
    # Tried in order, first 2xx response wins. Adding/removing entries here
    # is safe — the chain treats unknown IDs as soft failures and moves on.
    "meta-llama/llama-3.3-70b-instruct:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "meta-llama/llama-3.1-8b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "google/gemma-2-9b-it:free",
    "google/gemma-2-27b-it:free",
    "microsoft/phi-3-mini-128k-instruct:free",
    "microsoft/phi-3.5-mini-128k-instruct:free",
    "huggingfaceh4/zephyr-7b-beta:free",
    "qwen/qwen-2.5-7b-instruct:free",
    "qwen/qwen-2-7b-instruct:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "openchat/openchat-7b:free",
    "undi95/toppy-m-7b:free",
    "gryphe/mythomist-7b:free",
]


async def _openrouter(system: str, user: str, *, timeout: float) -> str:
    import os
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key: raise RuntimeError("no-openrouter-key")
    cb = _cb("openrouter")
    if not cb.ok(): raise RuntimeError("circuit-open")
    last_err: Exception | None = None
    for model in _OR_FREE_MODELS:
        try:
            async with httpx.AsyncClient(timeout=timeout) as cx:
                r = await cx.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"authorization": f"Bearer {key}"},
                    json={"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
                )
                r.raise_for_status()
                cb.failures.clear()
                log.info(json_event("openrouter.model.success", model=model))
                return r.json()["choices"][0]["message"]["content"]
        except Exception as e:
            last_err = e
            log.warning(json_event("openrouter.model.fail", model=model, error=type(e).__name__))
            continue
    raise RuntimeError(f"all openrouter models failed: {last_err}")


async def _pollinations(system: str, user: str, *, timeout: float) -> str:
    """Free; no API key. Used as the last-resort fallback.

    Pollinations hosts several free models behind the same OpenAI-shaped
    `/openai` endpoint. We try them in order; first 2xx with non-empty
    content wins. NEVER raises uncaught — every error path is captured.
    """
    cb = _cb("pollinations")
    if not cb.ok():
        raise RuntimeError("circuit-open")

    headers = {"accept": "application/json", "user-agent": "cognexa-ai/1.0"}

    sys_short = system[-1800:] if len(system) > 1800 else system
    user_short = user[-1800:] if len(user) > 1800 else user

    # Curated list of currently-free Pollinations models. Order matters:
    # the first one that returns a usable answer wins.
    models = ["openai", "openai-fast", "qwen-coder", "mistral", "llama"]

    last_err: Exception | None = None
    for model in models:
        try:
            async with httpx.AsyncClient(timeout=timeout) as cx:
                r = await cx.post(
                    "https://text.pollinations.ai/openai",
                    headers=headers,
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": sys_short},
                            {"role": "user", "content": user_short},
                        ],
                        "private": True,
                        "seed": 42,
                    },
                )
                if r.status_code >= 400:
                    raise RuntimeError(f"http {r.status_code}")
                try:
                    data = r.json()
                except Exception as je:
                    raise RuntimeError(f"json: {type(je).__name__}") from je
                if not isinstance(data, dict):
                    raise RuntimeError("non-dict response")
                choices = data.get("choices") or [{}]
                if not choices:
                    raise RuntimeError("no choices")
                msg = choices[0].get("message") if isinstance(choices[0], dict) else None
                text = (msg.get("content") if isinstance(msg, dict) else "") or ""
                if not text.strip():
                    raise RuntimeError("empty content")
                cb.failures.clear()
                log.info(json_event("pollinations.model.ok", model=model))
                return text.strip()
        except Exception as e:
            last_err = e
            log.warning(json_event("pollinations.model.fail", model=model, error=type(e).__name__))
            continue

    cb.trip()
    raise RuntimeError(f"all pollinations models failed: {type(last_err).__name__ if last_err else 'unknown'}")


_CHAIN: list[tuple[str, Callable[..., Awaitable[str]]]] = [
    ("openai", _openai),
    ("cloudflare", _cloudflare),
    ("openrouter", _openrouter),
    ("pollinations", _pollinations),
]


async def generate(system: str, user: str, *, timeout: float) -> tuple[str, str]:
    last_err: Exception | None = None
    for name, fn in _CHAIN:
        try:
            text = await fn(system, user, timeout=timeout)
            if name != _CHAIN[0][0]:
                log.warning(json_event("provider.fallback", chosen=name))
            return text, name
        except Exception as e:  # noqa: BLE001 — must NEVER leak past generate()
            try:
                _cb(name).trip()
            except Exception:
                pass
            last_err = e
            try:
                log.warning(json_event("provider.fail", name=name, error=type(e).__name__))
            except Exception:
                pass
            continue
    try:
        log.error(json_event("provider.exhausted", error=str(last_err) if last_err else "unknown"))
    except Exception:
        pass
    return ("I'm having trouble reaching my reasoning providers right now. Your message was saved — please try again in a moment.", "degraded")


def json_event(event: str, **kw: Any) -> str:
    import json
    return f"{event} {json.dumps({k: v for k, v in kw.items() if v is not None}, default=str)}"
