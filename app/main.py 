import json
import asyncio
import time
import random
import sys
import traceback
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import PlainTextResponse, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, and_

from app.config import get_settings
from app.database import init_db, get_db, AsyncSessionLocal, WebhookEvent, MessageQueue, MessageStatus, DeadLetter
from app.redis_client import get_redis, close_redis
from app.security import get_security_manager
from app.webhook_handler import WebhookNormalizer, MessageClassifier, StateMachine
from app.webhook_handler import MessageClassifier as Classifier

import structlog
import httpx

# LAZY: do not call get_settings() at import time.
# This lets the module be imported even when env vars are missing,
# so uvicorn can start and show a clear error on startup instead of
# the vague "Could not import module".

normalizer = WebhookNormalizer()
state_machine = StateMachine()

structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger("wax_gateway")
app = FastAPI(title="Wax Prep Gateway", version="1.0.0-render")


@app.on_event("startup")
async def startup():
    # VALIDATE SETTINGS EARLY with a clear error message.
    # If env vars are missing, this fails fast with a readable traceback
    # in the container logs instead of uvicorn's "Could not import module".
    try:
        settings = get_settings()
        logger.info("settings_loaded", environment=settings.ENVIRONMENT)
    except Exception as e:
        print("=" * 60, file=sys.stderr)
        print("FATAL: Failed to load settings. Check your environment variables.", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        raise SystemExit(1) from e

    await init_db()
    asyncio.create_task(background_processor())
    logger.info("gateway_started", environment=settings.ENVIRONMENT)


@app.on_event("shutdown")
async def shutdown():
    await close_redis()
    logger.info("gateway_shutdown")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "1.0.0-render",
        "stage": "webhook",
        "platform": "render"
    }


@app.get("/webhook")
async def verify_webhook(
    hub_mode: str,
    hub_verify_token: str,
    hub_challenge: str
):
    settings = get_settings()
    if hub_mode != "subscribe":
        raise HTTPException(status_code=400, detail="Invalid mode")
    if hub_verify_token != settings.WHATSAPP_VERIFY_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")
    logger.info("webhook_verified")
    return PlainTextResponse(content=hub_challenge)


@app.post("/webhook")
async def receive_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    sec = get_security_manager()
    start_time = time.time()
    raw_body = await request.body()

    # IP Check
    client_ip = request.headers.get("x-forwarded-for", request.client.host)
    if not sec.is_ip_allowed(client_ip.split(",")[0].strip()):
        logger.warning("ip_blocked", ip=client_ip)
        raise HTTPException(status_code=403, detail="IP not allowed")

    # Signature
    signature = request.headers.get("x-hub-signature-256")
    if not sec.verify_signature(raw_body, signature):
        logger.warning("signature_invalid", ip=client_ip)
        raise HTTPException(status_code=403, detail="Invalid signature")

    # Parse
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # Normalize
    normalized = normalizer.normalize(payload)
    if not normalized:
        return JSONResponse(content={"status": "ignored"})

    # Rate Limiting
    phone = normalized.get("phone_number", "")
    if not await check_rate_limit(phone):
        logger.warning("rate_limit_hit", phone=phone)
        return JSONResponse(content={"status": "rate_limited"})

    # Idempotency
    message_id = normalized.get("message_id", "")
    if not await check_idempotency(message_id):
        logger.info("duplicate_dropped", message_id=message_id)
        return JSONResponse(content={"status": "duplicate"})

    # Persist immutable log
    sealed_payload = sec.seal_payload(raw_body.decode())
    stream_type = Classifier.classify(payload)
    stream_name = f"wax:msg:{stream_type}"

    event_log = WebhookEvent(
        event_id=message_id or normalized.get("fingerprint"),
        payload_encrypted=sealed_payload,
        signature=signature or "",
        stream_name=stream_name
    )
    db.add(event_log)
    await db.commit()

    # Enqueue for processing
    sealed_normalized = sec.seal_payload(json.dumps(normalized))
    queue_item = MessageQueue(
        event_id=message_id or normalized.get("fingerprint"),
        payload_encrypted=sealed_normalized,
        stream_type=stream_type,
        status="pending"
    )
    db.add(queue_item)
    await db.commit()

    logger.info(
        "message_enqueued",
        wax_id=normalized["wax_id"],
        stream=stream_name,
        latency_ms=round((time.time() - start_time) * 1000, 2)
    )

    return JSONResponse(content={
        "status": "received",
        "trace_id": normalized.get("trace_id")
    })


async def check_rate_limit(phone_number: str) -> bool:
    settings = get_settings()
    redis = await get_redis()
    now = time.time()
    window = 60

    if redis:
        pipe = redis.pipeline()
        phone_key = f"rate_limit:phone:{phone_number}"
        global_key = "rate_limit:global"

        pipe.zremrangebyscore(phone_key, 0, now - window)
        pipe.zcard(phone_key)
        pipe.zadd(phone_key, {str(now): now})
        pipe.expire(phone_key, window + 1)

        pipe.zremrangebyscore(global_key, 0, now - window)
        pipe.zcard(global_key)
        pipe.zadd(global_key, {str(now): now})
        pipe.expire(global_key, window + 1)

        results = await pipe.execute()
        phone_count = results[1]
        global_count = results[5]

        return (phone_count <= settings.RATE_LIMIT_PER_PHONE and
                global_count <= settings.RATE_LIMIT_GLOBAL)
    else:
        async with AsyncSessionLocal() as session:
            return True


async def check_idempotency(message_id: str) -> bool:
    if not message_id:
        return True

    redis = await get_redis()
    if redis:
        key = f"idempotency:{message_id}"
        exists = await redis.exists(key)
        if exists:
            return False
        await redis.setex(key, 86400, "1")
        return True
    else:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(WebhookEvent).where(WebhookEvent.event_id == message_id)
            )
            return result.scalar_one_or_none() is None


async def background_processor():
    """Background task that runs inside the web process.
    Polls DB every 5 seconds for pending messages."""
    logger.info("background_processor_started")

    while True:
        try:
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(MessageQueue).where(
                        and_(
                            MessageQueue.status.in_(["pending", "retry"]),
                            MessageQueue.next_attempt_at <= datetime.utcnow()
                        )
                    ).order_by(MessageQueue.created_at).limit(5)
                )
                pending = result.scalars().all()

                for item in pending:
                    await process_queue_item(session, item)

        except Exception as e:
            logger.error("processor_error", error=str(e))

        await asyncio.sleep(5)


async def process_queue_item(session: AsyncSession, item: MessageQueue):
    settings = get_settings()
    sec = get_security_manager()

    await session.execute(
        update(MessageQueue).where(MessageQueue.id == item.id).values(
            status="processing",
            processed_at=datetime.utcnow()
        )
    )
    await session.commit()

    try:
        normalized = json.loads(sec.unseal_payload(item.payload_encrypted))

        if normalized["event_type"] == "status":
            await handle_status(session, normalized)

        if settings.AI_TEAM_WEBHOOK_URL:
            await forward_to_ai(normalized)

        await session.execute(
            update(MessageQueue).where(MessageQueue.id == item.id).values(
                status="completed",
                processed_at=datetime.utcnow()
            )
        )
        await session.commit()
        logger.info("message_processed", event_id=item.event_id, wax_id=normalized.get("wax_id"))

    except Exception as e:
        error_str = str(e)
        if item.retry_count < settings.MAX_RETRIES:
            delay = min(settings.RETRY_BASE_DELAY * (2 ** item.retry_count) + random.uniform(0, 1), 3600)
            next_attempt = datetime.utcnow() + timedelta(seconds=delay)

            await session.execute(
                update(MessageQueue).where(MessageQueue.id == item.id).values(
                    status="retry",
                    retry_count=item.retry_count + 1,
                    next_attempt_at=next_attempt,
                    error=error_str
                )
            )
            await session.commit()
            logger.warning("message_retry", event_id=item.event_id, attempt=item.retry_count + 1)
        else:
            dead = DeadLetter(
                event_id=item.event_id,
                payload_encrypted=item.payload_encrypted,
                error=error_str,
                retry_count=item.retry_count
            )
            session.add(dead)
            await session.execute(
                update(MessageQueue).where(MessageQueue.id == item.id).values(
                    status="dead_letter",
                    processed_at=datetime.utcnow()
                )
            )
            await session.commit()
            logger.error("message_dead_letter", event_id=item.event_id, error=error_str)


async def handle_status(session: AsyncSession, normalized: Dict[str, Any]):
    status = normalized.get("status")
    phone = normalized.get("phone_number", "")
    msg_id = normalized.get("message_id", "")
    timestamp = normalized.get("timestamp", 0)

    existing = await session.execute(
        select(MessageStatus).where(
            and_(
                MessageStatus.message_id == msg_id,
                MessageStatus.status == status
            )
        )
    )
    existing = existing.scalar_one_or_none()

    if not existing:
        new_status = MessageStatus(
            message_id=msg_id,
            phone_number=phone,
            status=status,
            timestamp=timestamp
        )
        session.add(new_status)
        await session.commit()
        await state_machine.transition(session, normalized)


async def forward_to_ai(normalized: Dict[str, Any]):
    settings = get_settings()
    headers = {"Content-Type": "application/json"}
    if settings.AI_TEAM_API_KEY:
        headers["X-API-Key"] = settings.AI_TEAM_API_KEY

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            settings.AI_TEAM_WEBHOOK_URL,
            json=normalized,
            headers=headers
        )
        response.raise_for_status()
        logger.info("forwarded_to_ai", wax_id=normalized.get("wax_id"), status=response.status_code)
