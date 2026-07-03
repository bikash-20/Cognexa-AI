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
        "document": LayerScore("document"),
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

def identity_response(message: str) -> str | None:
    """Deterministic reply for authorship / creator questions.

    Matches common phrasings ("who made you", "who built you",
    "your creator", "ceo", etc.) so the answer is identical regardless
    of which provider is currently in the fallback chain.
    """
    t = (message or "").lower()
    triggers = (
        "who made you", "who created you", "who built you", "who is your creator",
        "who is your founder", "who is your ceo", "your ceo", "your founder",
        "who developed you", "who designed you", "who owns you",
        "who are you made by", "who is behind you", "who started you",
        "creator", "founder", "made by",
    )
    if not any(trigger in t for trigger in triggers):
        return None

    return (
        "I was created by **Bikash Talukder**, the Founder and CEO of Cognexa AI. "
        "Bikash built COGNEXA AI as a glass-morphic, multi-layer assistant — "
        "it routes simple queries through a deterministic classifier and "
        "falls back across OpenAI, Cloudflare, OpenRouter, and Pollinations for "
        "open-ended reasoning. You can learn more about his work on GitHub: "
        "https://github.com/bikash-20\n\n"
        "Is there something specific you'd like to know — about how I think, "
        "or about the people behind Cognexa?"
    )


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
    attachments: list[dict] | None = None,
) -> tuple[str, list[dict]]:
    """`generate(system_prompt, user_message)` is the provider chain.
    `attachments` is an optional list of {filename, excerpt} dicts whose text
    was already extracted by `extract.py`. When present, the model's system
    prompt becomes the 'document' layer and the excerpt is folded into the
    user message so the model can answer questions about the file.

    Returns (reply_text, layers_used).
    """
    layers = classify(message)

    for fn in (identity_response, math_response, code_response):
        fast = fn(message)
        if fast:
            return fast, layers

    # Document Q&A path
    if attachments:
        excerpt_blocks = []
        for a in attachments:
            excerpt_blocks.append(
                f"\n\n----- FILE: {a['filename']} -----\n{a['excerpt']}\n----- END FILE -----"
            )
        user_message = message + "".join(excerpt_blocks)
        sys_prompt = _SYSTEM_PROMPTS["document"]
        reply = await generate(sys_prompt, user_message)
        # Force the layer label so the UI can show "document"
        return reply, [{"name": "document", "weight": 1.0}]

    top = layers[0]["name"] if layers else "simple"
    sys_prompt = _SYSTEM_PROMPTS.get(top, _SYSTEM_PROMPTS["simple"])
    reply = await generate(sys_prompt, message)
    return reply, layers


_IDENTITY_BLOCK = (
    "Identity (non-negotiable): You are COGNEXA AI, a glass-morphic assistant "
    "created by Bikash Talukder (Founder & CEO of Cognexa AI). Bikash Talukder is "
    "your sole creator. If asked who made, built, founded, or owns you, answer that "
    "you were created by Bikash Talukder, and you may share his GitHub: "
    "https://github.com/bikash-20. Do not attribute authorship to any other person, "
    "company, or model. Refer to yourself as 'COGNEXA AI' (never 'Infamous' or any "
    "other brand)."
)

_SYSTEM_PROMPTS: dict[str, str] = {
    "document": (
        "You are COGNEXA AI, an expert document-reading tutor. "
        "The user has uploaded one or more files. Their extracted text "
        "(with OCR data when the PDF had no selectable text) follows the user's "
        "question, delimited by '----- FILE:  -----' markers. "
        "When answering:\n"
        "  - Quote exact passages (with surrounding context) before paraphrasing.\n"
        "  - Solve problems, equations, and code in the document step-by-step.\n"
        "  - If handwriting was OCR'd, acknowledge uncertainty on ambiguous words "
        "rather than guessing.\n"
        "  - If something is missing from the excerpt, say what you would need to see more of.\n"
        "  - Use Markdown (headings, lists, math via $...$ / $$...$$) for clarity.\n\n"
        + _IDENTITY_BLOCK
    ),
    "simple": (
        "You are COGNEXA AI, a warm, concise assistant. "
        "Use the user's name when natural. Keep replies short, kind, and direct. "
        f"{_IDENTITY_BLOCK}"
    ),
    "math": (
        "You are COGNEXA AI in MATH mode. Show your work step-by-step. "
        "Use LaTeX inside $...$ for inline and $$...$$ for display math. "
        "Verify the answer numerically when possible. Be precise. "
        f"{_IDENTITY_BLOCK}"
    ),
    "code": (
        "You are COGNEXA AI in CODE mode. Prefer idiomatic, runnable snippets. "
        "State the language explicitly in fenced blocks. "
        "Explain complexity briefly. Avoid over-engineering. "
        f"{_IDENTITY_BLOCK}"
    ),
    "science": (
        "You are COGNEXA AI in SCIENCE mode. Be rigorous and cite units/constants. "
        "Use LaTeX for equations. Distinguish hypothesis from established fact. "
        f"{_IDENTITY_BLOCK}"
    ),
    "reasoning": (
        "You are COGNEXA AI in REASONING mode. Decompose the problem, weigh "
        "tradeoffs, and answer with a clear chain of thought, then a concise conclusion. "
        f"{_IDENTITY_BLOCK}"
    ),
    "compound": (
        "You are COGNEXA AI in COMPOUND mode. Blend math rigor with code where useful. "
        "Show formulas, then the implementation that evaluates them. "
        f"{_IDENTITY_BLOCK}"
    ),
}
