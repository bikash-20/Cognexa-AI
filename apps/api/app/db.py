"""SQLite persistence via SQLAlchemy 2.x. Stateless API; DB is the source of truth."""
from __future__ import annotations
import os
from datetime import datetime
from typing import Iterator, Optional
from uuid import uuid4
from sqlalchemy import String, DateTime, create_engine, ForeignKey, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


class Base(DeclarativeBase):
    pass


class ChatSession(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_name: Mapped[str] = mapped_column(String(60), index=True, default="friend")
    title: Mapped[str] = mapped_column(String(200), default="New chat")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    messages: Mapped[list["Message"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Message.created_at"
    )


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    layer: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    session: Mapped["ChatSession"] = relationship(back_populates="messages")


class Attachment(Base):
    __tablename__ = "attachments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_name: Mapped[str] = mapped_column(String(60), index=True, default="friend")
    session_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(default=0)
    page_count: Mapped[int] = mapped_column(default=0)
    engines: Mapped[str] = mapped_column(String(120), default="")
    had_ocr: Mapped[bool] = mapped_column(default=False)
    full_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


# Backwards-compat alias (older code referenced `Session`).
Session = ChatSession


_engine = create_engine(os.environ.get("DB_URL", "sqlite:///./infamous.db"), future=True)
SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(_engine)


def get_session() -> Iterator[ChatSession]:
    with SessionLocal() as s:
        yield s
