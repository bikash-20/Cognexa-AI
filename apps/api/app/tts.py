"""TTS service.

Priority: ElevenLabs → Cloudflare TTS → silent WAV fallback.

The active ElevenLabs voice id is sourced from (in order):
  1. `req.voice` per-request (sent by the frontend)
  2. `ELEVENLABS_VOICE_ID` env var (Render env)
  3. `voice_id` env var (legacy lowercase variant)
  4. Built-in default — Rachel (`21m00Tcm4TlvDq8ikWAM`)

This means changing the voice on Render requires no code change:
just edit the `ELEVENLABS_VOICE_ID` env var and restart the service.
The frontend can also override per-call by sending `voice` in the body.
"""
from __future__ import annotations
import os
import httpx
import logging
from typing import Optional

log = logging.getLogger("tts")


async def synth(
    text: str,
    *,
    voice: Optional[str],
    timeout: float,
    elevenlabs_voice_id: Optional[str] = None,
) -> tuple[bytes, str]:
    """Return (audio_bytes, provider_tag).

    `provider_tag` is one of: "elevenlabs", "cloudflare", "silent".
    The route handler sets `Content-Type` and an `x-tts-provider` header
    from this tag.
    """
    # Resolve which ElevenLabs voice to use.
    # Per-request override > explicit arg > legacy `voice_id` env > canonical
    # `ELEVENLABS_VOICE_ID` env > hard-coded fallback.
    chosen_voice = (
        voice
        or elevenlabs_voice_id
        or os.environ.get("voice_id")
        or os.environ.get("ELEVENLABS_VOICE_ID")
        or "21m00Tcm4TlvDq8ikWAM"
    )

    # 1) ElevenLabs -----------------------------------------------------
    el_key = os.environ.get("ELEVENLABS_API_KEY")
    if el_key:
        try:
            async with httpx.AsyncClient(timeout=timeout) as cx:
                r = await cx.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{chosen_voice}",
                    headers={
                        "xi-api-key": el_key,
                        "accept": "audio/mpeg",
                    },
                    json={
                        "text": text,
                        "model_id": "eleven_turbo_v2_5",
                        "voice_settings": {
                            "stability": 0.5,
                            "similarity_boost": 0.7,
                        },
                    },
                )
                if r.status_code >= 400:
                    # Surface the *body* too — ElevenLabs returns
                    # {"detail": {"message": "...", "status": "..."}}
                    # which is gold for debugging voice-id typos.
                    body_preview = (r.text or "")[:300]
                    log.warning(
                        f"elevenlabs.http status={r.status_code} "
                        f"voice={chosen_voice} body={body_preview!r}"
                    )
                else:
                    log.info(f"elevenlabs.ok voice={chosen_voice} bytes={len(r.content)}")
                r.raise_for_status()
                return r.content, "elevenlabs"
        except httpx.HTTPStatusError as e:
            # Already logged above with body. Fall through.
            log.warning(f"elevenlabs.fail status={e.response.status_code}")
        except Exception as e:
            log.warning(f"elevenlabs.fail {type(e).__name__}: {e}")

    # 2) Cloudflare TTS --------------------------------------------------
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if acct and tok:
        try:
            async with httpx.AsyncClient(timeout=timeout) as cx:
                r = await cx.post(
                    f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/tts",
                    headers={"authorization": f"Bearer {tok}"},
                    json={"text": text, "voice": "en-US-Standard-A"},
                )
                r.raise_for_status()
                log.info(f"cloudflare.tts.ok bytes={len(r.content)}")
                return r.content, "cloudflare"
        except Exception as e:
            log.warning(f"cloudflare.tts.fail {type(e).__name__}: {e}")

    # 3) Silent WAV — never raw 500. The frontend sees
    #    x-tts-provider: silent and falls back to browser speechSynthesis.
    from .silence import silent_wav
    log.warning(
        "tts.no_provider_configured "
        f"elevenlabs_key_set={bool(el_key)} "
        f"cloudflare_set={bool(acct and tok)}"
    )
    return silent_wav(sec=1), "silent"
