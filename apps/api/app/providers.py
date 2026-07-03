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
    "meta-llama/llama-3.2-3b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "google/gemma-2-9b-it:free",
    "microsoft/phi-3-mini-128k-instruct:free",
    "huggingfaceh4/zephyr-7b-beta:free",
    "meta-llama/llama-3.1-8b-instruct:free",
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
    cb = _cb("pollinations")
    if not cb.ok(): raise RuntimeError("circuit-open")
    async with httpx.AsyncClient(timeout=timeout) as cx:
        r = await cx.get("https://text.pollinations.ai/", params={"system": system, "user": user})
        r.raise_for_status()
        cb.failures.clear()
        return r.text


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
        except Exception as e:
            _cb(name).trip()
            last_err = e
            log.warning(json_event("provider.fail", name=name, error=type(e).__name__))
    log.error(json_event("provider.exhausted", error=str(last_err)))
    return ("I'm having trouble reaching my reasoning providers right now. Your message was saved — please try again in a moment.", "degraded")


def json_event(event: str, **kw: Any) -> str:
    import json
    return f"{event} {json.dumps({k: v for k, v in kw.items() if v is not None}, default=str)}"
