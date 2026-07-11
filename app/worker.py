import json
import asyncio
import httpx

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import AsyncSessionLocal, MessageStatus, MessageQueue
from app.security import security
from app.webhook_handler import StateMachine
from app.queue import publisher

settings = get_settings()
state_machine = StateMachine()


class BackgroundWorker:
    def __init__(self):
        self.running = True
    
    async def run(self):
        while self.running:
            try:
                async with AsyncSessionLocal() as session:
                    pending = await publisher.get_pending(session, limit=5)
                    
                    for item in pending:
                        if not self.running:
                            break
                        await self._process_one(session, item)
                        
            except Exception as e:
                print(f"Worker error: {e}")
            
            await asyncio.sleep(2)  # Poll every 2 seconds
    
    async def _process_one(self, session: AsyncSession, item: MessageQueue):
        await publisher.mark_processing(session, item.id)
        
        try:
            normalized = json.loads(security.unseal_payload(item.payload_encrypted))
            
            # Handle status state machine
            if normalized["event_type"] == "status":
                await self._handle_status(session, normalized)
            
            # Forward to AI team if configured
            if settings.AI_TEAM_WEBHOOK_URL:
                await self._forward_to_ai(normalized)
            
            await publisher.mark_completed(session, item.id)
            
        except Exception as e:
            if item.retry_count < settings.MAX_RETRIES:
                await publisher.schedule_retry(session, item.id, item.retry_count + 1, settings.RETRY_BASE_DELAY)
            else:
                await publisher.mark_dead(session, item.id)
    
    async def _handle_status(self, session: AsyncSession, normalized: Dict):
        result = await session.execute(
            select(MessageStatus).where(
                MessageStatus.message_id == normalized["message_id"]
            ).order_by(MessageStatus.timestamp.desc())
        )
        current = result.scalar_one_or_none()
        current_status = current.status if current else None
        new_status = normalized["status"]
        
        inferences = state_machine.infer_missing_states(current_status, new_status)
        
        if state_machine.can_transition(current_status, new_status):
            for inferred in inferences:
                session.add(MessageStatus(
                    message_id=normalized["message_id"],
                    phone_number=normalized["phone_number"],
                    status=inferred,
                    timestamp=normalized["timestamp"] - 1
                ))
            
            session.add(MessageStatus(
                message_id=normalized["message_id"],
                phone_number=normalized["phone_number"],
                status=new_status,
                timestamp=normalized["timestamp"]
            ))
            await session.commit()
    
    async def _forward_to_ai(self, normalized: Dict):
        headers = {"Content-Type": "application/json"}
        if settings.AI_TEAM_API_KEY:
            headers["X-API-Key"] = settings.AI_TEAM_API_KEY
        headers["X-Trace-ID"] = normalized.get("trace_id", "")
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                settings.AI_TEAM_WEBHOOK_URL,
                json=normalized,
                headers=headers
            )
            response.raise_for_status()
    
    def stop(self):
        self.running = False


worker = BackgroundWorker()
