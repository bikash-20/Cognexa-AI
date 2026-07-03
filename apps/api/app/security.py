"""Input inspection + output sanitisation layers."""
from __future__ import annotations
import re

# Raw 4-19 digit runs (cards, phone numbers, etc) — Block B in the brief.
_DIGITS = re.compile(r"\b\d{4,19}\b")
_OTP = re.compile(r"\b\d{3,8}\b")
_PROMPT_INJ = re.compile(r"(?i)ignore (previous|all) instructions|disclose (the )?(system|api) ?key|<\\|system\\|>")
_SCAN_CODES = re.compile(r"(?i)rm -rf|/etc/passwd|api[_-]?key\\s*[:=]")


def inspect_input(text: str) -> tuple[bool, str | None]:
    """Returns (ok, reason)."""
    if _PROMPT_INJ.search(text):
        return False, "flagged: possible prompt injection"
    if _SCAN_CODES.search(text):
        return False, "flagged: suspicious instruction pattern"
    if len(text) > 4000:
        return False, "flagged: input too long"
    return True, None


_SENS_KEYS = ("password", "secret", "token", "otp", "pin", "cvv", "ssn", "email", "phone")


def sanitize_output(text: str) -> str:
    """Layer 5 — output sanitisation, BOTH for log echo and for API response."""
    text = _DIGITS.sub("[redacted-number]", text)
    text = _OTP.sub("[redacted-otp]", text)
    for k in _SENS_KEYS:
        text = re.sub(rf"(?i){k}\\s*[:=]\\s*[^\\s]+", f"{k}=[redacted]", text)
    return text


def mask_for_log(text: str) -> str:
    """Aggressive log-side redaction. Never log full user content."""
    if len(text) > 120:
        return f"[{len(text)} chars redacted]"
    return sanitize_output(text)
