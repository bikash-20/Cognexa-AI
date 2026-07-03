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
    # Only treat as code if user is asking for code/algorithm/implementation,
    # not if they merely mention a language name in a conceptual question.
    code_signal = re.search(r"\b(python|javascript|typescript|java|c\+\+|rust|go|sql|regex)\b", text, re.I) and \
                  re.search(r"\b(code|program|script|function|class|implement|write|solve|algorithm|complexity|example|snippet|debug|compile|syntax)\b", text, re.I)
    boilerplate = re.search(r"```|^\s*def\s|^\s*class\s|\bfunction\s*\(|O\(n\)|O\(n\^2\)", text, re.M)
    return bool(code_signal or boilerplate)


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


def techstack_response(message: str) -> str | None:
    """Deterministic reply for meta-questions about COGNEXA's engineering.

    Covers the gateway, deterministic classifier, multi-layer fallback chain,
    async/SSE streaming, Pydantic v2 contracts, SQLite persistence, and the
    React/Vite/Tailwind frontend. Fires before any provider is called so the
    answer is identical regardless of which provider is currently healthy.
    """
    t = (message or "").lower()
    triggers = (
        "tech stack", "techstack", "tech-stack",
        "your architecture", "how are you built", "how are you made",
        "how do you work", "how does it work", "how do you think",
        "your backend", "your frontend", "your stack",
        "fallback chain", "fallback architecture", "multi-layer fallback",
        "dynamic routing", "provider chain", "provider fallback",
        "asynchronous", "async", "resilience", "error resilience",
        "state management", "errors and fallback",
        "deterministic classifier", "deterministic intent", "intent classifier",
        "the gateway", "your gateway", "the gateway &",
        "your engineering", "engineering details", "backend details",
        "how you handle", "how you manage", "errors and fallback",
        "your providers", "your fallback", "your model",
        "openai", "cloudflare", "openrouter", "pollinations",
    )
    if not any(trigger in t for trigger in triggers):
        return None

    return (
        "Here's the engineering under the hood of **COGNEXA AI** 👇\n\n"
        "### Gateway & Deterministic Intent Classifier\n"
        "- Every request enters **FastAPI** in `apps/api/app/main.py` and passes "
        "through a **correlation-id middleware** plus a **global exception guard** "
        "that returns a fixed error envelope instead of leaking stack traces.\n"
        "- `security.inspect_input` rejects prompt-injection, suspicious shell "
        "patterns, and oversized input ( >4000 chars) **before** any LLM call.\n"
        "- `brain.classify` is a **regex-based layer classifier** — no LLM hop "
        "is made for routing. It tags the prompt as `math`, `code`, `science`, "
        "`reasoning`, `compound`, `simple`, or `document`.\n"
        "- Specialist recipes (`identity_response`, `math_response`, "
        "`code_response`, `techstack_response`, `skills_response`) are tried "
        "first. If any returns, the chain stops here and **no external provider "
        "is ever called** — these are deterministic, zero-hallucination answers.\n\n"
        "### Multi-Layer Fallback Architecture (Dynamic Routing)\n"
        "- The provider chain in `providers.py` walks **OpenAI → Cloudflare → "
        "OpenRouter → Pollinations** in order.\n"
        "- Each provider has its own **circuit breaker**: 3 fails in 30s opens "
        "it for 20s, so a flapping upstream cannot stall the request.\n"
        "- **Pollinations is intentionally last** — it is free, key-less, and "
        "burns no quota. With zero env vars configured you still get a working "
        "chatbot, just slower and slightly less accurate.\n"
        "- When the chain exhausts, a **degraded message** is returned with "
        "`degraded: true`. The UI shows a soft banner; the conversation keeps "
        "going — there is no broken state.\n\n"
        "### Asynchronous Streaming (SSE)\n"
        "- `POST /api/v1/chat/stream` emits **Server-Sent Events** "
        "(`session → chunk → done`) with `Cache-Control: no-cache` and "
        "`X-Accel-Buffering: no` so proxies don't buffer.\n"
        "- The frontend parses chunks, batches them with "
        "`requestAnimationFrame` (~30fps), and shows a blinking caret as each "
        "token lands. An `AbortController` cancels in-flight streams on unmount.\n\n"
        "### Contracts, Persistence, Security\n"
        "- **Pydantic v2** with `extra=\"forbid\"` rejects unknown fields at "
        "the boundary — the same schema validates incoming requests and shapes "
        "outgoing responses.\n"
        "- **SQLAlchemy 2 + SQLite** stores sessions and message history; "
        "attachments cap at 200 KB per file and are stored as extracted text, "
        "never raw blobs.\n"
        "- PDF ingestion is **digital-first**: `pdfplumber → pypdf → "
        "`pdf2image + pytesseract` OCR, pages parallelized in a "
        "`ThreadPoolExecutor`. OCR is graceful — missing `tesseract`/`poppler` "
        "downgrades to a per-page warning, not a failure.\n"
        "- `security.sanitize_output` redacts card-shaped runs, OTP runs, and "
        "known sensitive key patterns **before** storage and **before** the "
        "response is sent.\n\n"
        "### Frontend\n"
        "- **React 18 + TypeScript (strict) + Vite**, file-style routing via "
        "`react-router-dom 6`.\n"
        "- **TanStack Query 5** for history invalidation; `useChat` owns "
        "optimistic-update bookkeeping for upload-then-ask flows.\n"
        "- **Tailwind 3 + CSS custom properties** for design tokens and glass "
        "morphism; **KaTeX** for math; **Shiki** for syntax highlighting in "
        "chat with a VS-Code-style dark theme.\n"
        "- **vite-plugin-pwa** adds an install prompt and offline shell.\n\n"
        "### Deployment\n"
        "- **Render free tier** hosts the FastAPI service (auto-deploy from "
        "`main`, no cold-start cost for SQLite).\n"
        "- **Vercel** hosts the static SPA at the edge.\n\n"
        "Want me to deep-dive on any single layer — the classifier heuristics, "
        "the circuit-breaker math, or the SSE parser?"
    )


def skills_response(message: str) -> str | None:
    """Deterministic reply for questions about Bikash's expertise."""
    t = (message or "").lower()
    triggers = (
        "bikash skills", "bikash's skills", "your founder skills",
        "founder expertise", "your ceo skills", "ceo skills",
        "your founder expertise", "your ceo expertise",
        "bikash expertise", "bikash background",
        "skills of bikash", "talukder skills", "talukder expertise",
        "what is bikash good at", "what can bikash do",
        "frontend and backend", "frontend backend ai", "backend and frontend",
        "machine learning and deep learning", "ml and dl", "ai/ml/dl",
        "ai ml dl", "ai machine learning and deep learning",
        "skilled all of the sector", "skilled in all sector",
        "skilled across", "all sectors", "all of the sector",
        "his skills", "his expertise", "your skills", "your expertise",
    )
    if not any(trigger in t for trigger in triggers):
        return None

    return (
        "**Bikash Talukder** is skilled across every layer of the stack — "
        "from the browser down to the model weights.\n\n"
        "### 🎨 Frontend\n"
        "- **React 18 + TypeScript (strict)** — design systems, optimistic UI, "
        "SSE consumers, PWA shells.\n"
        "- **Vite, Next.js, Tailwind, CSS custom properties** — fast iteration, "
        "narrow bundles, themed glass-morphism.\n"
        "- **State & data**: TanStack Query, Zustand, Redux Toolkit, custom "
        "hooks for streaming + optimistic updates.\n"
        "- **UI craft**: KaTeX-rendered math, Shiki syntax highlighting, "
        "accessible focus rings, reduced-motion respect.\n\n"
        "### ⚙️ Backend\n"
        "- **Python + FastAPI** (async, Pydantic v2 with `extra=\"forbid\"`, "
        "streaming responses, middleware composition).\n"
        "- **Node.js + Express / Hono** for high-throughput APIs.\n"
        "- **SQLAlchemy 2, PostgreSQL, SQLite, Redis** — async sessions, "
        "migration discipline, connection-pool tuning.\n"
        "- **Auth & security**: input inspection, output sanitisation, "
        "prompt-injection defense, circuit breakers, rate limiting.\n\n"
        "### 🧠 AI / Machine Learning\n"
        "- **LLM orchestration**: chained providers (OpenAI, Cloudflare, "
        "OpenRouter, Pollinations), fallback & degradation patterns, "
        "token-by-token streaming, deterministic classifiers.\n"
        "- **Retrieval**: vector stores, semantic cache, hybrid search.\n"
        "- **Classical ML**: scikit-learn, XGBoost, LightGBM, feature "
        "engineering, evaluation harnesses.\n\n"
        "### 🔬 Deep Learning\n"
        "- **PyTorch & TensorFlow / Keras** — training, fine-tuning, and "
        "evaluating transformer and CNN architectures.\n"
        "- **Hugging Face Transformers** — LoRA / QLoRA fine-tuning, "
        "quantization (GPTQ, AWQ, bitsandbytes), inference optimization.\n"
        "- **Computer Vision**: YOLO, ResNet, ViT, OpenCV pipelines; OCR "
        "via `pytesseract` + `pdf2image`.\n"
        "- **NLP**: tokenization, embeddings, RAG, prompt engineering, "
        "structured-output contracts.\n\n"
        "### 🛠️ Engineering Practices\n"
        "- Ships with **strict typing, lint discipline, and small, reviewable "
        "PRs**. Prefers boring tech that fails loudly over clever tech that "
        "fails quietly.\n"
        "- Comfortable across the full lifecycle: **design → prototype → "
        "ship → measure → iterate**.\n\n"
        "Bikash's GitHub: https://github.com/bikash-20\n\n"
        "Want a code sample from any one of these areas, or a deeper write-up "
        "of how it's wired into COGNEXA?"
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

    for fn in (identity_response, math_response, code_response, techstack_response, skills_response):
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
