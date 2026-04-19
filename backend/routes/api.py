from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import case, desc, func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Chat, Message
from ..schemas import ChatDetailOut, ChatIn, ChatListItem, MessageBatchIn, MessageOut
from ..services import build_source_id

router = APIRouter(prefix="/api", tags=["api"])


@router.post("/chats")
async def upsert_chat(chat: ChatIn, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    stmt = insert(Chat).values(
        id=chat.id,
        title=chat.title,
        created_at=chat.created_at,
    )

    incoming_title = func.lower(func.trim(stmt.excluded.title))
    title_update = case(
        (incoming_title == "", Chat.title),
        (incoming_title == "untitled chat", Chat.title),
        else_=stmt.excluded.title,
    )

    stmt = stmt.on_conflict_do_update(
        index_elements=[Chat.id],
        set_={
            "title": title_update,
            "created_at": func.coalesce(stmt.excluded.created_at, Chat.created_at),
        },
    )

    await db.execute(stmt)
    await db.commit()
    return {"status": "ok", "chat_id": chat.id}


@router.post("/messages")
async def upsert_messages(
    payload: MessageBatchIn,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int | str]:
    chat_stmt = insert(Chat).values(id=payload.chat_id, title="Untitled chat")
    chat_stmt = chat_stmt.on_conflict_do_nothing(index_elements=[Chat.id])
    await db.execute(chat_stmt)

    if not payload.messages:
        await db.commit()
        return {"status": "ok", "processed": 0}

    records: list[dict[str, object]] = []
    for index, message in enumerate(payload.messages):
        source_id = message.source_id or build_source_id(
            chat_id=payload.chat_id,
            role=message.role,
            content=message.content,
            timestamp=message.timestamp,
            index=index,
        )

        records.append(
            {
                "chat_id": payload.chat_id,
                "source_id": source_id,
                "role": message.role,
                "content": message.content,
                "timestamp": message.timestamp,
            }
        )

    stmt = insert(Message).values(records)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Message.chat_id, Message.source_id],
        set_={
            "role": stmt.excluded.role,
            "content": stmt.excluded.content,
            "timestamp": stmt.excluded.timestamp,
        },
    )

    await db.execute(stmt)
    await db.commit()
    return {"status": "ok", "processed": len(records)}


@router.get("/chats", response_model=list[ChatListItem])
async def get_chats(
    search: str | None = Query(default=None, max_length=200),
    db: AsyncSession = Depends(get_db),
) -> list[ChatListItem]:
    stmt = (
        select(
            Chat.id,
            Chat.title,
            Chat.created_at,
            func.count(Message.id).label("message_count"),
            func.max(Message.timestamp).label("last_message_at"),
        )
        .outerjoin(Message, Message.chat_id == Chat.id)
        .group_by(Chat.id)
        .order_by(desc(func.coalesce(func.max(Message.timestamp), Chat.created_at)))
    )

    if search:
        stmt = stmt.where(Chat.title.ilike(f"%{search}%"))

    result = await db.execute(stmt)
    rows = result.all()

    return [
        ChatListItem(
            id=row.id,
            title=row.title,
            created_at=row.created_at,
            message_count=row.message_count,
            last_message_at=row.last_message_at,
        )
        for row in rows
    ]


@router.get("/chats/{chat_id}", response_model=ChatDetailOut)
async def get_chat_detail(chat_id: str, db: AsyncSession = Depends(get_db)) -> ChatDetailOut:
    chat_result = await db.execute(select(Chat).where(Chat.id == chat_id))
    chat = chat_result.scalar_one_or_none()

    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found")

    message_result = await db.execute(
        select(Message)
        .where(Message.chat_id == chat_id)
        .order_by(Message.timestamp.is_(None), Message.timestamp, Message.id)
    )
    messages = message_result.scalars().all()

    return ChatDetailOut(
        id=chat.id,
        title=chat.title,
        created_at=chat.created_at,
        messages=[
            MessageOut(
                id=message.id,
                source_id=message.source_id,
                role=message.role,
                content=message.content,
                timestamp=message.timestamp,
            )
            for message in messages
        ],
    )


@router.get("/chats/{chat_id}/export")
async def export_chat(chat_id: str, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    detail = await get_chat_detail(chat_id=chat_id, db=db)
    payload = jsonable_encoder(
        {
            "chat": {
                "id": detail.id,
                "title": detail.title,
                "created_at": detail.created_at,
            },
            "messages": detail.messages,
        }
    )
    return JSONResponse(content=payload)
