import json
from datetime import datetime, timedelta
from typing import Dict, Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import MessageQueue
from app.security import security
from app.webhook_handler import MessageClassifier


class SQLiteQueue:
    """SQLite-based message queue. Replaces Redis Streams."""
    
    async def publish(self, session: AsyncSession, normalized_event: Dict[str, Any], raw_payload: str) -> str:
        stream_type = MessageClassifier.classify(json.loads(raw_payload))
        
        sealed_raw = security.seal_payload(raw_payload)
        sealed_normalized = security.seal_payload(json.dumps(normalized_event))
        
        queue_item = MessageQueue(
            event_id=normalized_event.get("message_id") or normalized_event.get("fingerprint"),
            payload_encrypted=sealed_normalized,
            stream_type=stream_type,
            status="pending"
        )
        session.add(queue_item)
        await session.commit()
        
        return stream_type, queue_item.id
    
    async def get_pending(self, session: AsyncSession, limit: int = 10):
        from sqlalchemy import and_
        result = await session.execute(
            select(MessageQueue).where(
                and_(
                    MessageQueue.status.in_(["pending", "retry"]),
                    MessageQueue.next_attempt_at <= datetime.utcnow()
                )
            ).order_by(MessageQueue.created_at).limit(limit)
        )
        return result.scalars().all()
    
    async def mark_processing(self, session: AsyncSession, item_id: int):
        await session.execute(
            update(MessageQueue).where(MessageQueue.id == item_id).values(
                status="processing",
                processed_at=datetime.utcnow()
            )
        )
        await session.commit()
    
    async def mark_completed(self, session: AsyncSession, item_id: int):
        await session.execute(
            update(MessageQueue).where(MessageQueue.id == item_id).values(
                status="completed",
                processed_at=datetime.utcnow()
            )
        )
        await session.commit()
    
    async def schedule_retry(self, session: AsyncSession, item_id: int, attempt: int, base_delay: float):
        delay = min(base_delay * (2 ** attempt) + __import__('random').uniform(0, 1), 3600)
        next_attempt = datetime.utcnow() + timedelta(seconds=delay)
        
        await session.execute(
            update(MessageQueue).where(MessageQueue.id == item_id).values(
                status="retry",
                retry_count=attempt,
                next_attempt_at=next_attempt
            )
        )
        await session.commit()
    
    async def mark_dead(self, session: AsyncSession, item_id: int):
        from app.database import DeadLetter
        result = await session.execute(select(MessageQueue).where(MessageQueue.id == item_id))
        item = result.scalar_one()
        
        dead = DeadLetter(
            event_id=item.event_id,
            payload_encrypted=item.payload_encrypted,
            error="Max retries exceeded",
            retry_count=item.retry_count
        )
        session.add(dead)
        
        await session.execute(
            update(MessageQueue).where(MessageQueue.id == item_id).values(status="dead")
        )
        await session.commit()


publisher = SQLiteQueue()
