"""FastAPI entry. Wires routers, exception envelope, health checks, and logging."""
from __future__ import annotations
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session as OrmSession

from .config import get_settings
from .db import init_db, get_session, Attachment
from .schemas import (
    ChatRequest, ChatReply, TtsRequest, ErrorEnvelope, ChatMessage,
    BrainLayer, AttachmentSummary, UploadResponse,
)
from .security import inspect_input, sanitize_output, mask_for_log
from .brain import answer as brain_answer
from .providers import generate as provider_generate
from . import tts as tts_mod
from . import extract as extract_mod
from .logging_utils import configure as cfg_logging, new_cid, get_cid

cfg_logging()
log = logging.getLogger("api")

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    log.info("boot.ok")
    yield
    log.info("shutdown.ok")


app = FastAPI(title="COGNEXA AI", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://cognexa-ai.vercel.app",
        "http://localhost:5173",
        "http://localhost:4173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


# ---- Correlation-id middleware ---------------------------------------------
@app.middleware("http")
async def cid_middleware(request: Request, call_next):
    cid = request.headers.get("x-correlation-id") or new_cid()
    log.info(f"http.start method={request.method} path={request.url.path}")
    try:
        response = await call_next(request)
    except Exception as e:  # noqa: BLE001 — final guard, must never leak raw stack
        log.exception(f"http.unhandled error={type(e).__name__}")
        body = ErrorEnvelope(error="internal", code="unhandled", correlation_id=get_cid()).model_dump()
        return JSONResponse(body, status_code=500, headers={"x-correlation-id": cid})
    response.headers["x-correlation-id"] = cid
    log.info(f"http.end status={response.status_code}")
    return response


# ---- Error envelope --------------------------------------------------------
@app.exception_handler(HTTPException)
async def http_exc(_: Request, exc: HTTPException):
    body = ErrorEnvelope(error=str(exc.detail), code=f"http.{exc.status_code}",
                         correlation_id=get_cid()).model_dump()
    return JSONResponse(body, status_code=exc.status_code, headers={"x-correlation-id": get_cid()})


# ---- Health checks (distinguishing liveness vs readiness) ------------------
@app.get("/healthz", include_in_schema=False)
def liveness():
    return {"status": "alive"}


@app.get("/readyz", include_in_schema=False)
def readiness(db: OrmSession = Depends(get_session)):
    db.execute(__import__("sqlalchemy").text("SELECT 1"))
    return {"status": "ready", "providers": ["openai", "cloudflare", "openrouter", "pollinations"]}


# ---- Sessions + History ----------------------------------------------------
@app.post("/api/v1/chat", response_model=ChatReply)
async def chat(req: ChatRequest, db: OrmSession = Depends(get_session)):
    new_cid()
    ok, why = inspect_input(req.message)
    if not ok:
        log.warning(f"chat.rejected reason={why}")
        raise HTTPException(status_code=400, detail="Input rejected by safety layer.")

    # Persist / fetch session.
    if req.session_id:
        session_id = str(req.session_id)
        from .db import Session as DSession
        sess = db.get(DSession, session_id)
    else:
        from .db import Session as DSession
        sess = DSession(user_name=req.user_name,
                        title=(req.message[:48] + "…") if len(req.message) > 48 else req.message)
        db.add(sess)
        db.flush()
        session_id = sess.id

    # Stash the user message.
    from .db import Message as DMessage
    db.add(DMessage(session_id=session_id, role="user", content=req.message))
    db.commit()

    # Brain + provider chain.
    async def gen(sys: str, user: str) -> str:
        text, provider = await provider_generate(sys, user, timeout=settings.chat_timeout_s)
        log.info(f"provider.used name={provider} len={len(text)}")
        return text

    try:
        attachments = _fetch_attachments(db, req.attachment_ids or [])
        reply_text, layers_used = await brain_answer(req.message, gen, attachments=attachments)
    except Exception:
        log.exception("brain.failed")
        reply_text = "I ran into a problem. Please retry."
        layers_used = [{"name": BrainLayer.SIMPLE, "weight": 1.0}]
        degraded = True
    else:
        degraded = False

    safe_text = sanitize_output(reply_text)

    msg = ChatMessage(
        id=uuid4(),
        role="assistant",
        content=safe_text,
        created_at=__import__("datetime").datetime.utcnow(),
        layer=BrainLayer(layers_used[0]["name"]) if layers_used else BrainLayer.SIMPLE,
    )
    from .db import Message as DMessage2
    db.add(DMessage2(session_id=session_id, role="assistant",
                     layer=msg.layer.value, content=safe_text))
    db.commit()

    # Log safe (no PII) preview only.
    log.info(f"chat.ok layers={layers_used} preview={mask_for_log(safe_text)}")

    return ChatReply(
        session_id=UUID(session_id),
        message=msg,
        layers_used=[{"name": BrainLayer(l["name"]), "weight": l["weight"]} for l in layers_used],
        degraded=degraded,
        attachments_used=[a["id"] for a in (attachments or [])] or None,
    )


@app.get("/api/v1/history/{session_id}")
def history(session_id: str, db: OrmSession = Depends(get_session)):
    from .db import Session as DSession, Message as DMessage
    sess = db.get(DSession, session_id)
    if not sess:
        raise HTTPException(404, "session not found")
    msgs = db.query(DMessage).filter_by(session_id=session_id).order_by(DMessage.created_at).all()
    return {
        "session": {"id": sess.id, "user_name": sess.user_name, "title": sess.title, "updated_at": sess.updated_at.isoformat()},
        "messages": [{"role": m.role, "content": m.content, "layer": m.layer, "created_at": m.created_at.isoformat()} for m in msgs],
    }


@app.get("/api/v1/sessions")
def sessions(db: OrmSession = Depends(get_session)):
    from .db import Session as DSession
    rows = db.query(DSession).order_by(DSession.updated_at.desc()).limit(20).all()
    return {"sessions": [
        {"id": s.id, "title": s.title, "user_name": s.user_name, "updated_at": s.updated_at.isoformat()}
        for s in rows
    ]}


# ---- TTS -------------------------------------------------------------------
@app.post("/api/v1/tts")
async def tts(req: TtsRequest):
    new_cid()
    if not req.text.strip():
        raise HTTPException(400, "text required")
    audio, provider = await tts_mod.synth(req.text, voice=req.voice, timeout=settings.tts_timeout_s)
    log.info(f"tts.ok provider={provider} bytes={len(audio)}")
    media = "audio/mpeg" if provider != "silent" else "audio/wav"
    return Response(content=audio, media_type=media,
                    headers={"x-tts-provider": provider, "x-correlation-id": get_cid()})


# ---- Friendly root for sanity checks ---------------------------------------
@app.get("/")
def root():
    return {
        "service": "cognexa-ai",
        "version": app.version,
        "creator": "Bikash Talukder",
        "docs": "/docs",
    }

# ---- Document upload + extraction ----------------------------------------
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", tempfile.gettempdir())) / "cognexa_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))  # 25 MB


@app.post("/api/v1/uploads", response_model=UploadResponse)
async def upload(file: UploadFile = File(...), db: OrmSession = Depends(get_session)):
    """Accept a PDF or image, extract text (digital + OCR fallback), persist
    an attachment record, and return an excerpt the UI can preview.

    The LLM is NOT called here — extraction is local. Whether an LLM has the
    keys configured is decided later in the chat route.
    """
    new_cid()
    filename = (file.filename or "upload").strip() or "upload"
    head = await file.read(8)
    await file.seek(0)
    blob = await file.read()
    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file_too_large: max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")

    kind = extract_mod.detect_mime(filename, head)
    if kind == "unknown":
        raise HTTPException(status_code=415, detail="unsupported_file_type: PDF or image required")

    # Stream to disk in case we want to re-process later.
    safe_name = f"{uuid4().hex}_{Path(filename).name}"
    path = UPLOAD_DIR / safe_name
    path.write_bytes(blob)

    if kind == "pdf":
        result = extract_mod.extract_pdf(path)
        mime = "application/pdf"
    else:
        result = extract_mod.extract_image(blob, filename)
        mime = (file.content_type or "image/*").split(";", 1)[0].strip() or "image/*"

    att = Attachment(
        user_name="friend",
        filename=filename,
        mime=mime,
        size_bytes=len(blob),
        page_count=result.page_count,
        engines=",".join(result.engines),
        had_ocr=result.had_ocr,
        full_text=result.text[:200_000],   # 200KB hard cap on stored text
    )
    db.add(att)
    db.commit()
    db.refresh(att)

    summary = AttachmentSummary(
        id=att.id,
        filename=att.filename,
        mime=att.mime,
        page_count=att.page_count,
        char_count=len(att.full_text),
        engines=result.engines,
        had_ocr=result.had_ocr,
        warnings=result.warnings,
        created_at=att.created_at.isoformat() + "Z",
    )
    log.info(
        f"upload.ok name={filename} kind={kind} pages={result.page_count} "
        f"chars={len(att.full_text)} engines={result.engines} "
        f"warnings={len(result.warnings)}"
    )

    # Friendly user-facing message they see in the chat preview.
    if result.text.strip():
        user_msg = (
            f"Got it — **{filename}** "
            f"({result.page_count} page{'s' if result.page_count != 1 else ''}, "
            f"{len(att.full_text):,} chars extracted"
            + (f", OCR used on {sum(1 for p in result.pages if p.method == 'ocr')} page"
               f"{'s' if sum(1 for p in result.pages if p.method == 'ocr') != 1 else ''}"
               if result.had_ocr else "")
            + "). Ask me anything about it."
        )
    else:
        user_msg = (
            f"I received **{filename}** but couldn't extract any text from it. "
            + (result.warnings[0] if result.warnings else
               "Make sure it contains readable content (PDF text layer or non-blank image).")
        )
    return UploadResponse(attachment=summary, excerpt=result.excerpt(), message=user_msg)


def _fetch_attachments(db: OrmSession, ids: list[str], limit_chars: int = 12_000) -> list[dict]:
    """Look up attachments and return a list of {filename, excerpt} dicts
    bounded per-file so the prompt never explodes."""
    if not ids:
        return []
    rows = db.query(Attachment).filter(Attachment.id.in_(ids)).all()
    out = []
    by_id = {a.id: a for a in rows}
    for aid in ids:
        a = by_id.get(aid)
        if not a:
            continue
        excerpt = a.full_text[:limit_chars]
        if len(a.full_text) > limit_chars:
            excerpt += "\n\n[...truncated for length...]"
        out.append({"filename": a.filename, "excerpt": excerpt, "id": a.id})
    return out