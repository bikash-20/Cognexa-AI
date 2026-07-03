"""Document extraction pipeline.

Design goals (the "senior dev" half):
  1. Never crash a request — every external call (pdfplumber, pypdf, tesseract,
     poppler) is wrapped so we always return a structured result the API can
     surface to the user.
  2. Pick the cheapest path that works:
        - Digital text PDF → pdfplumber (layout-aware) → pypdf fallback.
        - Scanned / image-only PDF / handwritten notes → render page to PNG via
          pdf2image (poppler) and OCR with Tesseract via pytesseract.
        - Image upload → direct OCR.
  3. Process pages in parallel (ThreadPool) — extraction is I/O + CPU bound.
  4. Return an `ExtractResult` with per-page detail so the UI can show
     "page 3 was OCR'd because it had no selectable text".
  5. Graceful degradation: if a binary is missing we record it in `warnings`
     instead of raising. The upload still succeeds with whatever text we got.

Nothing here talks to the network — extraction is a pure file → text stage.
The LLM is invoked later by the brain, only when a provider key is present.
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

log = logging.getLogger("api.extract")

# ---------------------------------------------------------------------------
# Optional deps — import lazily and tolerate absence so the API boots even
# on a slim image that lacks poppler/tesseract. We surface missing binaries
# in the ExtractResult.warnings list instead.
# ---------------------------------------------------------------------------
def _try_import(name: str):
    try:
        return __import__(name)
    except Exception as e:  # noqa: BLE001
        log.warning(f"extract.missing_module name={name} err={type(e).__name__}: {e}")
        return None


_pdfplumber = _try_import("pdfplumber")
_pypdf = _try_import("pypdf")
_pdf2image = _try_import("pdf2image")
_pytesseract = _try_import("pytesseract")
_PIL_Image = _try_import("PIL.Image")

MAX_PAGES = int(os.environ.get("EXTRACT_MAX_PAGES", "40"))          # hard cap per file
MAX_CHARS_PER_PAGE = int(os.environ.get("EXTRACT_MAX_CHARS_PAGE", "8000"))
OCR_DPI = int(os.environ.get("EXTRACT_OCR_DPI", "300"))
OCR_LANG = os.environ.get("EXTRACT_OCR_LANG", "eng")
OCR_TIMEOUT_S = float(os.environ.get("EXTRACT_OCR_TIMEOUT_S", "30"))
PARALLEL_WORKERS = int(os.environ.get("EXTRACT_WORKERS", "4"))


@dataclass
class PageExtract:
    index: int                         # 1-based page number
    text: str = ""
    method: str = "none"               # digital | ocr | none | error
    confidence: float | None = None    # OCR confidence, when available
    error: str | None = None

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


@dataclass
class ExtractResult:
    text: str = ""
    pages: list[PageExtract] = field(default_factory=list)
    page_count: int = 0
    engines: list[str] = field(default_factory=list)   # e.g. ["pdfplumber", "tesseract"]
    warnings: list[str] = field(default_factory=list)
    duration_ms: int = 0

    @property
    def had_ocr(self) -> bool:
        return any(p.method == "ocr" for p in self.pages)

    def excerpt(self, max_chars: int = 12_000) -> str:
        """Truncated, deterministic excerpt safe to inline in an LLM prompt."""
        if len(self.text) <= max_chars:
            return self.text
        head = self.text[: int(max_chars * 0.7)]
        tail = self.text[-int(max_chars * 0.2) :]
        return f"{head}\n\n[…{len(self.text) - max_chars} chars truncated…]\n\n{tail}"


# ---------------------------------------------------------------------------
# Per-page extractors
# ---------------------------------------------------------------------------
def _extract_digital_page(pdf_path: Path, page_index: int) -> PageExtract:
    """Pull text from a single page using pdfplumber (preferred) → pypdf."""
    pe = PageExtract(index=page_index)

    if _pdfplumber is not None:
        try:
            with _pdfplumber.open(str(pdf_path)) as pdf:
                page = pdf.pages[page_index]
                txt = (page.extract_text() or "").strip()
                if txt:
                    pe.text = _trim(txt)
                    pe.method = "digital"
                    return pe
        except Exception as e:  # noqa: BLE001
            pe.error = f"pdfplumber: {e}"

    if _pypdf is not None:
        try:
            reader = _pypdf.PdfReader(str(pdf_path))
            page = reader.pages[page_index]
            txt = (page.extract_text() or "").strip()
            if txt:
                pe.text = _trim(txt)
                pe.method = "digital"
        except Exception as e:  # noqa: BLE001
            pe.error = f"{pe.error or ''} pypdf: {e}".strip()

    return pe


def _ocr_pdf_page(pdf_path: Path, page_index: int) -> PageExtract:
    """Render a single PDF page to PNG, then OCR it."""
    pe = PageExtract(index=page_index)

    if _pdf2image is None or _pytesseract is None or _PIL_Image is None:
        pe.error = "ocr_unavailable"
        return pe

    try:
        from pdf2image import convert_from_path  # type: ignore
        # Render only this page — fast and low-memory.
        images = convert_from_path(
            str(pdf_path),
            dpi=OCR_DPI,
            first_page=page_index + 1,
            last_page=page_index + 1,
            thread_count=1,
        )
        if not images:
            pe.error = "render_failed"
            return pe
        img = images[0]

        # Tesseract returns per-word data; we aggregate text + mean confidence.
        try:
            data = _pytesseract.image_to_data(
                img, lang=OCR_LANG, output_type=_pytesseract.Output.DICT, timeout=OCR_TIMEOUT_S
            )
        except RuntimeError as e:
            # Tesseract binary missing or timed out.
            pe.error = f"tesseract_runtime: {e}"
            return pe

        words: list[str] = []
        confs: list[float] = []
        for w, c in zip(data.get("text", []), data.get("conf", [])):
            try:
                cf = float(c)
            except (TypeError, ValueError):
                cf = -1.0
            if w and cf >= 0:
                words.append(w)
                confs.append(cf)
        pe.text = _trim(" ".join(words))
        pe.method = "ocr"
        if confs:
            pe.confidence = round(sum(confs) / len(confs) / 100.0, 3)
    except Exception as e:  # noqa: BLE001
        pe.error = f"ocr: {e}"
    return pe


def _ocr_image_bytes(data: bytes, filename: str) -> PageExtract:
    """OCR a standalone image (jpg/png/webp)."""
    pe = PageExtract(index=1)
    if _pytesseract is None or _PIL_Image is None:
        pe.error = "ocr_unavailable"
        return pe
    try:
        img = _PIL_Image.open(io.BytesIO(data))
        data_dict = _pytesseract.image_to_data(
            img, lang=OCR_LANG, output_type=_pytesseract.Output.DICT, timeout=OCR_TIMEOUT_S
        )
        words: list[str] = []
        confs: list[float] = []
        for w, c in zip(data_dict.get("text", []), data_dict.get("conf", [])):
            try:
                cf = float(c)
            except (TypeError, ValueError):
                cf = -1.0
            if w and cf >= 0:
                words.append(w)
                confs.append(cf)
        pe.text = _trim(" ".join(words))
        pe.method = "ocr"
        if confs:
            pe.confidence = round(sum(confs) / len(confs) / 100.0, 3)
    except RuntimeError as e:
        pe.error = f"tesseract_runtime: {e}"
    except Exception as e:  # noqa: BLE001
        pe.error = f"ocr: {e}"
    return pe


def _trim(s: str) -> str:
    s = " ".join(s.split())
    return s[:MAX_CHARS_PER_PAGE]


# ---------------------------------------------------------------------------
# Top-level entrypoints
# ---------------------------------------------------------------------------
def extract_pdf(pdf_path: Path) -> ExtractResult:
    """Extract text from every page in a PDF, mixing digital + OCR as needed."""
    t0 = time.time()
    res = ExtractResult()

    # Page count
    page_count = 0
    if _pdfplumber is not None:
        try:
            with _pdfplumber.open(str(pdf_path)) as pdf:
                page_count = len(pdf.pages)
                res.engines.append("pdfplumber")
        except Exception as e:  # noqa: BLE001
            res.warnings.append(f"pdfplumber_open: {e}")
    if page_count == 0 and _pypdf is not None:
        try:
            reader = _pypdf.PdfReader(str(pdf_path))
            page_count = len(reader.pages)
            res.engines.append("pypdf")
        except Exception as e:  # noqa: BLE001
            res.warnings.append(f"pypdf_open: {e}")

    if page_count == 0:
        res.warnings.append("could_not_count_pages")
        return res

    res.page_count = page_count
    if page_count > MAX_PAGES:
        res.warnings.append(f"page_cap_hit: capped at {MAX_PAGES} of {page_count}")
        page_count = MAX_PAGES

    # Pass 1 — digital text on all pages in parallel.
    pages: list[PageExtract] = [PageExtract(index=i + 1) for i in range(page_count)]
    with ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
        futs = {ex.submit(_extract_digital_page, pdf_path, i): i for i in range(page_count)}
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                pages[i] = fut.result()
            except Exception as e:  # noqa: BLE001
                pages[i].error = f"digital_dispatch: {e}"

    # Pass 2 — OCR only the pages that came back empty (or errored).
    empty_idx = [i for i, p in enumerate(pages) if p.is_empty and p.method != "ocr"]
    if empty_idx and _pdf2image is not None and _pytesseract is not None:
        res.engines.append("tesseract")
        with ThreadPoolExecutor(max_workers=max(1, PARALLEL_WORKERS // 2)) as ex:
            futs = {ex.submit(_ocr_pdf_page, pdf_path, i): i for i in empty_idx}
            for fut in as_completed(futs):
                i = futs[fut]
                try:
                    pages[i] = fut.result()
                except Exception as e:  # noqa: BLE001
                    pages[i].error = f"ocr_dispatch: {e}"

    # Finalize
    res.pages = pages
    pieces: list[str] = []
    for p in pages:
        header = f"\n\n===== Page {p.index}"
        if p.method == "ocr":
            conf = f" (ocr, conf={p.confidence:.2f})" if p.confidence is not None else " (ocr)"
            header += conf
        elif p.method == "none" or p.is_empty:
            header += " (no text extracted)"
        header += " =====\n"
        if p.text:
            pieces.append(header + p.text)
        elif p.error:
            pieces.append(header + f"[error: {p.error}]")
        else:
            pieces.append(header + "[empty]")

    res.text = "".join(pieces).strip()
    res.duration_ms = int((time.time() - t0) * 1000)

    if not res.engines:
        res.warnings.append("no_extraction_engine_available")
    if res.had_ocr is False and any(p.is_empty for p in res.pages):
        res.warnings.append("some_pages_blank")
    log.info(
        f"extract.pdf pages={res.page_count} engines={res.engines} "
        f"ocr_pages={sum(1 for p in res.pages if p.method == 'ocr')} "
        f"warnings={len(res.warnings)} ms={res.duration_ms}"
    )
    return res


def extract_image(data: bytes, filename: str) -> ExtractResult:
    """OCR a standalone image (jpg/png/webp/heic/bmp/tiff)."""
    t0 = time.time()
    res = ExtractResult()
    res.engines = ["tesseract"] if _pytesseract is not None else []
    page = _ocr_image_bytes(data, filename)
    res.pages = [page]
    res.page_count = 1
    if page.text:
        res.text = f"===== Page 1 (ocr) =====\n{page.text}"
    elif page.error == "ocr_unavailable":
        res.warnings.append("ocr_unavailable_install_tesseract")
    elif page.error:
        res.warnings.append(page.error)
    res.duration_ms = int((time.time() - t0) * 1000)
    return res


def detect_mime(filename: str, head: bytes) -> str:
    """Return one of: 'pdf', 'image', 'unknown'."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    name = filename.lower()
    if name.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".heif")):
        return "image"
    if head.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"RIFF", b"BM")):
        return "image"
    return "unknown"