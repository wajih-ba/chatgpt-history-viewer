import hashlib
from datetime import datetime


def build_source_id(
    chat_id: str,
    role: str,
    content: str,
    timestamp: datetime | None,
    index: int,
) -> str:
    timestamp_text = timestamp.isoformat() if timestamp else "none"
    raw = f"{chat_id}|{role}|{timestamp_text}|{content}|{index}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return digest[:40]
