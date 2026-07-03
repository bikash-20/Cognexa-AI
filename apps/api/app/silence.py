"""_silent_wav helper module (split for clarity)."""
from struct import pack


def silent_wav(sec: int = 1, rate: int = 8000) -> bytes:
    n = sec * rate
    data = b"\x00\x00" * n
    header = (
        b"RIFF" + pack("<I", 36 + len(data)) + b"WAVE" +
        b"fmt " + pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) +
        b"data" + pack("<I", len(data))
    )
    return header + data
