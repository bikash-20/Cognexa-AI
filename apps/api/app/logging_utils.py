"""Structured logging helpers. JSON-lines per event with correlation id propagation."""
from __future__ import annotations
import json, logging, time, uuid
from contextvars import ContextVar

CID: ContextVar[str] = ContextVar("cid", default="-")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "cid": CID.get(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure() -> None:
    h = logging.StreamHandler()
    h.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(h)
    root.setLevel(logging.INFO)


def new_cid() -> str:
    cid = uuid.uuid4().hex
    CID.set(cid)
    return cid


def get_cid() -> str:
    return CID.get()
