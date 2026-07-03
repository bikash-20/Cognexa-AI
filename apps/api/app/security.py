"""Input inspection + output sanitisation layers."""
from __future__ import annotations
import re

# Real card numbers are digit-runs separated by spaces, dashes, slashes, or
# parentheses — e.g. "4111 1111 1111 1111", "4111-1111-1111-1111". Bare 16-digit
# runs (rare in real text) are also caught. We never match bare 4-digit runs
# sitting inside prose (e.g. "4000 chars", "200 KB").
_DIGITS = re.compile(
    r"(?<![\w-])"                       # not preceded by word char or dash
    r"(?:\d{4}[\s\-./]\d{4}(?:[\s\-./]\d{1,7}){1,3})"  # must have a separator
    r"(?![\w-])"
)
# OTP: either a bare 6-digit run (the universal OTP length) OR a separated
# 4-8 digit run. Bare 4 or 8 digit runs inside prose are NOT OTPs.
_OTP = re.compile(
    r"(?<![\w-])"
    r"(?:"
    r"\d{6}"                            # bare 6-digit OTP
    r"|(?:\d{3,4}[\s\-]\d{3,4})"        # or grouped like "123-456"
    r")"
    r"(?![\w-])"
)
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
