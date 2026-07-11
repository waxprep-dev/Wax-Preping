from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, String, DateTime, Integer, Text, Index, UniqueConstraint, select, update, and_
from datetime import datetime, timedelta
import urllib.parse

from app.config import get_settings

# LAZY: do NOT call get_settings() at import time
_engine = None
_AsyncSessionLocal = None

Base = declarative_base()


def _get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        db_url = settings.DATABASE_URL
        
        # FIX: asyncpg doesn't accept 'sslmode' as a keyword argument.
        # Parse the URL, extract ssl parameter, and pass it as connect_args.
        parsed = urllib.parse.urlparse(db_url)
        query_params = urllib.parse.parse_qs(parsed.query)
        
        ssl_arg = False
        if 'ssl' in query_params:
            ssl_val = query_params['ssl'][0].lower()
            if ssl_val in ('require', 'true', 'yes', '1'):
                ssl_arg = True
            del query_params['ssl']
        
        # Rebuild the query string without ssl
        new_query = urllib.parse.urlencode(query_params, doseq=True)
        db_url = urllib.parse.urlunparse(parsed._replace(query=new_query))
        
        _engine = create_async_engine(
            db_url,
            echo=False,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
            connect_args={"ssl": ssl_arg} if ssl_arg else {}
        )
    return _engine


def _get_session_local():
    global _AsyncSessionLocal
    if _AsyncSessionLocal is None:
        _AsyncSessionLocal = async_sessionmaker(
            _get_engine(), class_=AsyncSession, expire_on_commit=False
        )
    return _AsyncSessionLocal


class WaxUser(Base):
    __tablename__ = "wax_users"
    
    id = Column(String(32), primary_key=True)
    phone_hash = Column(String(64), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    __table_args__ = (UniqueConstraint('phone_hash', name='uix_phone_hash'),)


class WebhookEvent(Base):
    __tablename__ = "webhook_events"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(String(128), nullable=False, index=True)
    payload_encrypted = Column(Text, nullable=False)
    signature = Column(String(128), nullable=False)
    stream_name = Column(String(64), nullable=False)
    received_at = Column(DateTime, default=datetime.utcnow)
    
    __table_args__ = (Index('ix_event_id', 'event_id'),)


class MessageQueue(Base):
    __tablename__ = "message_queue"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(String(128), nullable=False, index=True)
    payload_encrypted = Column(Text, nullable=False)
    status = Column(String(20), default="pending")
    retry_count = Column(Integer, default=0)
    stream_type = Column(String(32), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    processed_at = Column(DateTime, nullable=True)
    next_attempt_at = Column(DateTime, nullable=True)
    error = Column(Text, nullable=True)


class MessageStatus(Base):
    __tablename__ = "message_statuses"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(String(128), nullable=False, index=True)
    phone_number = Column(String(32), nullable=False, index=True)
    status = Column(String(20), nullable=False)
    timestamp = Column(Integer, nullable=False)
    received_at = Column(DateTime, default=datetime.utcnow)
    
    __table_args__ = (Index('ix_msg_status', 'message_id', 'status', unique=True),)


class DeadLetter(Base):
    __tablename__ = "dead_letters"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(String(128), nullable=False)
    payload_encrypted = Column(Text, nullable=False)
    error = Column(Text, nullable=False)
    retry_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


async def init_db():
    async with _get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_db():
    async with _get_session_local()() as session:
        yield session


# Backward-compatible alias for code that uses AsyncSessionLocal directly
class AsyncSessionLocal:
    @classmethod
    async def __aenter__(cls):
        return _get_session_local()()
    
    @classmethod
    async def __aexit__(cls, exc_type, exc_val, exc_tb):
        pass
