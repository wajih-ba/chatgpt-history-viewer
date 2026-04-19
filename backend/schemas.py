from datetime import UTC, datetime

from pydantic import BaseModel, Field, field_validator


def parse_timestamp(value: object) -> datetime | None:
    if value is None:
        return None

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value

    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=UTC)

    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return None

        if candidate.endswith("Z"):
            candidate = candidate.replace("Z", "+00:00")

        return datetime.fromisoformat(candidate)

    raise ValueError("Unsupported timestamp format")


class ChatIn(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(default="Untitled chat", max_length=512)
    created_at: datetime | None = None

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        text = value.strip()
        return text if text else "Untitled chat"

    @field_validator("created_at", mode="before")
    @classmethod
    def normalize_created_at(cls, value: object) -> datetime | None:
        return parse_timestamp(value)


class MessageIn(BaseModel):
    source_id: str | None = Field(default=None, max_length=128)
    role: str = Field(min_length=1, max_length=32)
    content: str
    timestamp: datetime | None = None

    @field_validator("role")
    @classmethod
    def normalize_role(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        return value.strip()

    @field_validator("timestamp", mode="before")
    @classmethod
    def normalize_timestamp(cls, value: object) -> datetime | None:
        return parse_timestamp(value)


class MessageBatchIn(BaseModel):
    chat_id: str = Field(min_length=1, max_length=128)
    messages: list[MessageIn]


class ChatListItem(BaseModel):
    id: str
    title: str
    created_at: datetime | None
    message_count: int
    last_message_at: datetime | None


class MessageOut(BaseModel):
    id: int
    source_id: str
    role: str
    content: str
    timestamp: datetime | None


class ChatDetailOut(BaseModel):
    id: str
    title: str
    created_at: datetime | None
    messages: list[MessageOut]
