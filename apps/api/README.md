# Infamous AI Backend

## Run
```bash
cd apps/api
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # add keys you have; the rest fall back
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Architecture
See the top-level `ARCHITECTURE.md`.

## Endpoints
- `POST /api/v1/chat` — main chat endpoint (Pydantic strict, sanitised output).
- `GET  /api/v1/history/{session_id}`
- `GET  /api/v1/sessions`
- `POST /api/v1/tts` — ElevenLabs → Cloudflare → silent WAV fallback.
- `GET  /healthz` / `/readyz`
