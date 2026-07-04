# COGNEXA AI
<img width="1280" height="717" alt="image" src="https://github.com/user-attachments/assets/9d982198-e4b3-4984-b29e-29eb41e4bc5e" />


A chat assistant that doesn't lock you out. No account, no signup, no API key to paste in somewhere. You open the URL, you type, you get an answer. That was the whole product idea and everything else hangs off it.

Live:

- Web app:  https://cognexa-ai.vercel.app/chat
- API:      https://cognexa-ai.onrender.com
- API docs: https://cognexa-ai.onrender.com/docs

Built by Bikash Talukder. Source under `apps/`. There is no `apps/marketing` because there is no marketing department.

---

## Why this exists

Most "free" chat demos on the internet have a hidden step: sign in with Google, drop your email, generate a token, hit a usage quota, get paywalled. They are not free, they are lead capture.

COGNEXA is meant to feel different. The first message you send has no auth header. The backend doesn't know who you are, doesn't try to, and returns a real answer anyway. If you never come back, nothing breaks. If you come back tomorrow in a different browser, the previous conversation is gone and that is fine.

The cost of that decision is that inference has to run on someone else's bill. The system chains four providers behind one endpoint, paying nothing if there is no key configured, and falling back to a free public model (Pollinations) when the wallet is empty. Three of those providers are optional. Removing all of them — leaving only Pollinations — still produces a working chatbot. That is the floor.

Everything in this repo is built to keep that property intact.

---

## What you get

A glass-morphic single-page web app with three pages:

- `/`         — landing page with a name prompt and a "start chatting" button
- `/chat`     — the main assistant
- `/voice`    — text-to-speech playground that uses the same backend

The chat page renders Markdown, KaTeX math, code with syntax highlighting, and inline file chips. It also accepts PDF and image attachments — both kinds are extracted locally before the LLM sees them (no third party ever receives your upload). OCR runs on the server, not the browser, so a phone with a slow CPU still works.

The brain has six layers — simple, math, code, science, reasoning, compound — plus a separate path for document Q&A. A small deterministic rule-engine picks which one to use before any LLM call. Most "what is X" questions never need an external model because the answer is computed locally. When the layer is too ambiguous, the request is forwarded to the provider chain.

A small identity guard answers creator / authorship questions with a fixed string, so the answer is the same regardless of which provider is currently up.

---

## Architecture

Two apps. One repo. They deploy independently.

```
cognexa-ai/
  apps/
    api/                 FastAPI backend (Python 3.11, Pydantic v2)
      app/
        main.py          routes, middleware, CORS, error envelope
        brain.py         layer classifier + specialist recipes
        providers.py     OpenAI / Cloudflare / OpenRouter / Pollinations chain
        extract.py       PDF + image extraction (digital + OCR)
        tts.py           ElevenLabs → Cloudflare → silent WAV fallback
        db.py            SQLAlchemy 2.x + SQLite
        schemas.py       Pydantic contract — extra="forbid", strict everywhere
        security.py      input inspection + output sanitisation
        logging_utils.py correlation id per request
        config.py        pydantic-settings, .env-driven
      requirements.txt
    web/                 Vite + React 18 + TypeScript (strict)
      src/
        features/
          chat/          ChatHeader, ChatInput, ChatWindow, MessageBubble,
                          EmptyState, ErrorBanner, useChat hook
          landing/       LandingPage
          voice/         VoicePage
        shared/
          lib/           apiFetch (Zod-validated), logger, theme, uuid
          types/         contracts.ts — wire schemas mirroring the backend
          ui/            Markdown (with KaTeX), AnimatedOrb, ErrorBoundary,
                          global.css (theme tokens + glass utilities)
      vite.config.ts (PWA plugin enabled)
```

### Request lifecycle

A single chat message goes through this pipeline:

1.  Browser sends `POST /api/v1/chat` with `{ user_name, message, history?, session_id?, attachment_ids? }`.
2.  FastAPI validates the body against a Pydantic `Strict` model (extra fields rejected, whitespace stripped).
3.  `security.inspect_input` rejects obvious prompt-injection, suspicious system-prompt leaks, oversized input (>4000 chars), shell-script patterns.
4.  If `attachment_ids` are present, the matching rows are loaded from SQLite and their text excerpts are inlined into the system prompt.
5.  `brain.classify` decides the layer. The classifier is regex-based; no LLM call is made for routing.
6.  Specialist recipes (`identity_response`, `math_response`, `code_response`) are tried first. If any returns, the chain stops here and we never touch an external provider — these are deterministic, zero-hallucination answers.
7.  Otherwise, the layer's system prompt is selected and `providers.generate(system, user)` is called.
8.  The chain walks OpenAI → Cloudflare → OpenRouter → Pollinations. Each provider has its own circuit breaker (3 fails in 30s opens it for 20s). Pollinations tries 5 free models in sequence inside its own loop.
9.  When the chain exhausts, a degraded message is returned and `degraded: true` is set in the response. The UI shows a soft banner. The conversation continues — there is no broken state.
10. `security.sanitize_output` redacts card-number-shaped runs, OTP-shaped runs, and known sensitive key patterns before storage and before the response is sent back.
11. The user message and the assistant message are written to SQLite. The session is created lazily on first message; there is no separate `/sessions` write path.

Two middleware wrappers run on every request: a correlation-id injector that puts `x-correlation-id` on every response, and a global exception guard that returns a fixed error envelope for anything that escapes (rather than leaking a stack trace).

### Why a chain, not one provider

One provider means one outage away from a broken app. The chain makes the failure surface boring: any single provider can be down, rate-limited, or have a bad day and the user experience is unchanged. The first three providers are commercial; Pollinations is free and key-less. With no env vars configured you still get a working chatbot, just a slower and slightly less accurate one.

The chain is also where budget lives. Rendering the provider name in the `ChatReply` payload means the frontend can show "answer via openai-large today" — useful for debugging and for understanding cost. Pollinations is the only provider that doesn't burn quota, so it is last in the chain on purpose.

### Why local extraction

A naive chat-with-PDF app sends your PDF to OpenAI. We don't, for two reasons: privacy and latency. `extract.py` uses `pdfplumber` for the digital text layer first, falls back to `pypdf`, and only then to `pdf2image` + `pytesseract` for OCR. Pages are processed in a `ThreadPoolExecutor`. The OCR path has graceful binary tolerance — if `tesseract` or `poppler` aren't installed, the upload still succeeds with a per-page error in the warnings list.

The extracted text is stored in SQLite, capped at 200 KB per attachment. When a follow-up question arrives, only the excerpt is forwarded to the LLM, never the raw blob.

### Why a custom router instead of React Query for everything

`useChat` does its own optimistic-update bookkeeping because the upload-then-send flow has too many intermediate states for `useMutation` alone: file selection → upload progress → success → message attached → user edits text → submit → assistant placeholder → answer arrives → degrade → retry. The hook keeps an `AbortController` so a new send cancels any in-flight request, and stores attachment UI state in a ref-keyed map so that optimistic messages can be matched to their attachment chips even before the server has acknowledged anything.

---

## Tech stack

| Layer        | Choice                                   | Why                                     |
| ------------ | ---------------------------------------- | --------------------------------------- |
| Frontend     | React 18 + TypeScript (strict) + Vite    | fast HMR, narrow bundle, real types      |
| Routing      | react-router-dom 6                       | file-based feel without Next.js         |
| State        | TanStack Query 5 + custom hooks          | optimistic UI without RSC                |
| Validation   | Zod                                      | one schema, server + client             |
| Styling      | Tailwind 3 + CSS custom properties       | design tokens, dark themes              |
| Math         | KaTeX                                    | fast, no virtual-DOM cost in chat        |
| Markdown     | marked                                   | small, pluggable                         |
| Highlighting | shiki                                    | client-side syntax highlight             |
| PWA          | vite-plugin-pwa                          | install prompt, offline shell            |
| Backend      | FastAPI 0.115+                           | async, Pydantic native, OpenAPI built-in |
| Contracts    | Pydantic v2 (extra=forbid)               | reject unknown fields at the boundary    |
| DB           | SQLAlchemy 2 + SQLite                    | zero-ops, single file, future-portable   |
| PDF          | pdfplumber → pypdf → pdf2image + tesseract| digital first, OCR fallback             |
| HTTP client  | httpx (async)                            | one client across all providers          |
| TTS          | ElevenLabs → Cloudflare → silent WAV     | graceful degradation, no key required    |
| Deploy (API) | Render free tier                         | auto-deploy from main, no cold-start cost for SQLite |
| Deploy (Web) | Vercel                                   | edge cache for the static SPA            |

---

## Running it locally

Backend:

```bash
cd apps/api
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# add OPENAI_API_KEY, CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN,
# OPENROUTER_API_KEY, ELEVENLABS_API_KEY if you have them.
# Leaving them out means Pollinations-only mode.

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Frontend:

```bash
cd apps/web
npm install
npm run dev          # http://localhost:5173
npm run typecheck    # strict TS check
npm run lint
npm run build        # tsc + vite, lands in dist/
```

The web app reads its API URL from `VITE_API_BASE`. Without it, it points at `http://localhost:8000`.

OCR works out of the box on macOS once you install Poppler and Tesseract:

```bash
brew install poppler tesseract
```

Linux:

```bash
sudo apt-get install -y poppler-utils tesseract-ocr
```

---

## API surface

All routes are JSON. Errors return a fixed envelope:

```json
{ "error": "internal", "code": "unhandled", "correlation_id": "…" }
```

| Method | Path                         | Purpose                                       |
| ------ | ---------------------------- | --------------------------------------------- |
| GET    | `/`                          | service banner, version, creator name         |
| GET    | `/healthz`                   | liveness — no DB check                         |
| GET    | `/readyz`                    | readiness — pings DB and reports providers     |
| POST   | `/api/v1/chat`               | main chat; accepts message + optional `attachment_ids[]` |
| GET    | `/api/v1/history/{session_id}` | full thread for a session                    |
| GET    | `/api/v1/sessions`           | last 20 sessions                              |
| POST   | `/api/v1/uploads`            | PDF/image upload, returns id + excerpt + message |
| POST   | `/api/v1/tts`                | synthesise speech for text                     |
| POST   | `/docs`                      | Swagger UI (FastAPI-generated)                 |

The chat endpoint is intentionally compact. It doesn't stream. Each call is request → think → respond, which keeps the failure modes boring and the deployment story simple. If you want streaming, that's a separate frontend + backend track.

---

## Security model

There is no auth, but there is still a perimeter.

- **Input inspection** rejects known prompt-injection patterns and inputs longer than 4000 chars.
- **Output sanitisation** redacts digit runs (4–19 digits, cards/phones), OTP-shaped runs (3–8 digits), and any explicit sensitive-key pattern in the assistant reply.
- **CORS** is allowlisted. Hard-coded origins: `cognexa-ai.vercel.app`, `localhost:5173`, `localhost:4173`. There is no wildcard.
- **Uploads** are capped at 25 MB, sniffed by magic bytes, persisted with a UUID-prefixed filename, and never logged in full.
- **Logging** is masked server-side; full user content never appears in the log stream, only a length-tagged placeholder.

This is not enterprise security. It is enough for a public demo with arbitrary users and no SLA.

---

## Operational notes

Render free tier has limits. The service sleeps after 15 minutes of no traffic, then takes ~30 seconds to wake on the first request. The frontend's first chat click after a quiet period will appear slow; subsequent ones are fast. If you want zero cold starts, the upgrade path is Render's $7/mo starter plan.

SQLite lives on the Render disk. The free tier wipes the disk on every redeploy, which means sessions and attachments disappear on each push. That's why the app is stateless-by-design — losing history is acceptable, the user's conversation is their own, not ours.

If you want persistence, swap the database URL to a managed Postgres (Neon, Supabase) and run `init_db()` against it on boot. The model code in `db.py` is portable; nothing else needs to change.

The provider chain has been tuned for failure tolerance rather than quality. If you have a budget and want quality, populate `OPENAI_API_KEY` first — OpenAI answers will always come back first. The chain only reaches Pollinations when nothing else is configured.

---

## What this is not

A production SaaS. A replacement for ChatGPT. A research project. A claim that any of the providers used are accurate or safe for high-stakes decisions. It is a working chatbot you can fork, deploy in an afternoon, and modify without permission.

If you fork it and ship something interesting, link back. The author is [@bikash-20 on GitHub](https://github.com/bikash-20).

---

## License

MIT. Use it, change it, ship it. Attribution appreciated, not required.
