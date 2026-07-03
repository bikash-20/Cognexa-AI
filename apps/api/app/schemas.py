"""Pydantic v2 strict contract. Unknown fields are rejected at the boundary."""
from __future__ import annotations
from datetime import datetime
from enum import Enum
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Role(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class BrainLayer(str, Enum):
    SIMPLE = "simple"
    COMPOUND = "compound"
    COMPLEX = "complex"
    REASONING = "reasoning"
    SPECIALIST = "specialist"
    DOCUMENT = "document"
    MATH = "math"
    CODE = "code"
    SCIENCE = "science"


class ChatMessage(Strict):
    id: UUID
    role: Role
    content: str = Field(min_length=1, max_length=20_000)
    created_at: datetime
    layer: BrainLayer | None = None
    sources: list[str] | None = None


class ChatRequest(Strict):
    user_name: str = Field(default="guest", min_length=1, max_length=60)
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=40)
    session_id: UUID | None = None
    attachment_ids: list[str] = Field(default_factory=list, max_length=8)


class LayerUsage(Strict):
    name: BrainLayer
    weight: float = Field(ge=0, le=1)


class ChatReply(Strict):
    session_id: UUID
    message: ChatMessage
    layers_used: list[LayerUsage]
    degraded: bool | None = False
    attachments_used: list[str] | None = None


class AttachmentSummary(Strict):
    id: str
    filename: str
    mime: str
    page_count: int
    char_count: int
    engines: list[str]
    had_ocr: bool
    warnings: list[str]
    created_at: str


class UploadResponse(Strict):
    attachment: AttachmentSummary
    excerpt: str
    message: str


class TtsRequest(Strict):
    text: str = Field(min_length=1, max_length=2000)
    voice: str | None = None


class ErrorEnvelope(Strict):
    error: str
    code: str
    detail: str | None = None
    correlation_id: str | None = None
