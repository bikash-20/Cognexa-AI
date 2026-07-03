"""Layered reasoning brain.

   A deterministic rule engine classifies the user input first; only ambiguous
   or open-ended prompts reach the LLM provider chain.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable


@dataclass
class LayerScore:
    name: str
    weight: float = 0.0
    notes: list[str] = field(default_factory=list)

    def bump(self, w: float, note: str = "") -> None:
        self.weight += w
        if note:
            self.notes.append(note)


def _looks_like_math(text: str) -> bool:
    return bool(re.search(r"[=\^]|d/dx|sin|cos|tan|log|sqrt|\\int", text)) or \
           bool(re.search(r"\b\d+\s*[+\-*/^]\s*\d+\b", text))


def _looks_like_code(text: str) -> bool:
    return bool(re.search(r"\b(python|javascript|typescript|java|c\+\+|rust|go|sql|regex|algorithm)\b", text, re.I)) or \
           bool(re.search(r"```|def |class |function |algorithm|complexity|O\(n", text))


def _looks_like_science(text: str) -> bool:
    return bool(re.search(r"\b(physics|chemistry|biology|organic|quantum|cell|kreb|electron|force|joule|mole)\b", text, re.I))


def classify(text: str) -> list[dict]:
    """Return ordered [layer] descriptors with weights. Highest first."""
    layers = {
        "math": LayerScore("math"),
        "code": LayerScore("code"),
        "science": LayerScore("science"),
        "reasoning": LayerScore("reasoning"),
        "compound": LayerScore("compound"),
        "simple": LayerScore("simple"),
    }
    n_words = max(1, len(text.split()))

    if _looks_like_math(text):     layers["math"].bump(2.0, "math signals")
    if _looks_like_code(text):     layers["code"].bump(2.0, "code signals")
    if _looks_like_science(text):  layers["science"].bump(1.5, "science signals")

    if text.strip().endswith("?") and n_words > 8:
        layers["reasoning"].bump(1.2, "open-ended question")

    if layers["math"].weight and layers["code"].weight:
        layers["compound"].bump(1.5, "math+code overlap")

    if not any(l.weight > 0 for l in layers.values() if l.name not in ("simple",)):
        layers["simple"].bump(1.0, "no specialist signal")

    out = [{"name": l.name, "weight": round(l.weight, 3), "notes": l.notes}
           for l in layers.values() if l.weight > 0]
    out.sort(key=lambda x: x["weight"], reverse=True)
    return out


# ------------- Specialist recipes (deterministic, zero-hallucination) ---------

def math_response(message: str) -> str | None:
    """Cheap, exact answers for the most common student queries."""
    m = re.search(r"d/dx\s*([a-z0-9_]+)\s*=\s*\?\??", message, re.I)
    if m:
        return "Could you share the expression explicitly (e.g., `d/dx(x^2 + sin(x))`)? I'll derive it step-by-step."

    m = re.search(r"\b(\d+)\s*([+\-*/])\s*(\d+)\b", message)
    if m and "?" in message:
        a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
        try:
            r = {"+": a + b, "-": a - b, "*": a * b, "/": a / b if b else None}[op]
        except Exception:
            r = None
        return f"**{a} {op} {b} = {r}**" if r is not None else "Cannot divide by zero."
    return None


def code_response(message: str) -> str | None:
    """Return a brute-force two-sum snippet when the user is exploring that algo."""
    if re.search(r"\btwo[- ]?sum\b", message, re.I) and re.search(r"\b(python|brute|alg|algorithm)\b", message, re.I):
        return (
            "Here's a brute-force **two-sum** in Python:\n\n"
            "```python\n"
            "def two_sum(nums, target):\n"
            "    n = len(nums)\n"
            "    for i in range(n):\n"
            "        for j in range(i + 1, n):\n"
            "            if nums[i] + nums[j] == target:\n"
            "                return [i, j]\n"
            "    return [-1, -1]\n"
            "```\n\n"
            "**Complexity:** $O(n^2)$ time, $O(1)$ extra space.\n\n"
            "Want me to show the $O(n)$ hash-map version next?"
        )
    return None


async def answer(
    message: str,
    generate: Callable[[str, str], Awaitable[str]],
) -> tuple[str, list[dict]]:
    """`generate(system_prompt, user_message)` is the provider chain.
    Returns (reply_text, layers_used).
    """
    layers = classify(message)

    for fn in (math_response, code_response):
        fast = fn(message)
        if fast:
            return fast, layers

    top = layers[0]["name"] if layers else "simple"
    sys_prompt = _SYSTEM_PROMPTS.get(top, _SYSTEM_PROMPTS["simple"])
    reply = await generate(sys_prompt, message)
    return reply, layers


_SYSTEM_PROMPTS: dict[str, str] = {
    "simple": (
        "You are Infamous AI, a warm, concise assistant. "
        "Use the user's name when natural. Keep replies short, kind, and direct."
    ),
    "math": (
        "You are Infamous AI in MATH mode. Show your work step-by-step. "
        "Use LaTeX inside $...$ for inline and $$...$$ for display math. "
        "Verify the answer numerically when possible. Be precise."
    ),
    "code": (
        "You are Infamous AI in CODE mode. Prefer idiomatic, runnable snippets. "
        "State the language explicitly in fenced blocks. "
        "Explain complexity briefly. Avoid over-engineering."
    ),
    "science": (
        "You are Infamous AI in SCIENCE mode. Be rigorous and cite units/constants. "
        "Use LaTeX for equations. Distinguish hypothesis from established fact."
    ),
    "reasoning": (
        "You are Infamous AI in REASONING mode. Decompose the problem, weigh "
        "tradeoffs, and answer with a clear chain of thought, then a concise conclusion."
    ),
    "compound": (
        "You are Infamous AI in COMPOUND mode. Blend math rigor with code where useful. "
        "Show formulas, then the implementation that evaluates them."
    ),
}
