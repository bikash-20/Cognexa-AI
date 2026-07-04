"""Centralised, validated settings. Boots fail-fast on missing required env."""
from __future__ import annotations
import os
import sys
from functools import lru_cache
from pydantic import BaseModel, Field, ValidationError


class Settings(BaseModel):
    api_prefix: str = "/api/v1"
    db_url: str = "sqlite:///./infamous.db"
    log_level: str = "INFO"
    request_timeout_s: float = 8.0
    chat_timeout_s: float = 30.0
    tts_timeout_s: float = 12.0

    openai_api_key: str | None = None
    cloudflare_account_id: str | None = None
    cloudflare_api_token: str | None = None
    openrouter_api_key: str | None = None
    elevenlabs_api_key: str | None = None
    # Dynamic ElevenLabs voice id. Render env may be either ELEVENLABS_VOICE_ID
    # (preferred) or the legacy lowercase "voice_id" key. Default to the
    # canonical "Rachel" voice id so the API works out-of-the-box.
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"
    cors_origin: str = "*"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    raw = {k: os.environ.get(k) for k in (
        "OPENAI_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN",
        "OPENROUTER_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
        "DB_URL", "LOG_LEVEL", "CORS_ORIGIN",
        "REQUEST_TIMEOUT_S", "CHAT_TIMEOUT_S", "TTS_TIMEOUT_S"
    )}
    # Tolerate the lowercase variant some UIs (and older docs) expose.
    if not raw.get("ELEVENLABS_VOICE_ID"):
        legacy = os.environ.get("voice_id")
        if legacy:
            raw["ELEVENLABS_VOICE_ID"] = legacy
    try:
        s = Settings(**{k.lower(): v for k, v in raw.items() if v is not None})
    except ValidationError as e:
        print("[boot] Invalid configuration:", e, file=sys.stderr)
        raise SystemExit(2)
    return s
