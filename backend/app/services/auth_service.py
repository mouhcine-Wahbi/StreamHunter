from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.errors import AuthError, ConflictError, ForbiddenError
from app.models import AuthSession, User
from app.schemas.auth import LoginRequest, RegisterRequest
from app.utils.security import hash_password, hash_token, new_session_token, password_needs_rehash, verify_password

log = logging.getLogger("streamhunter.auth")

# Avoid a DB write on every request just to bump last_used_at.
_TOUCH_INTERVAL = timedelta(minutes=5)


class AuthService:
    def __init__(self, db: AsyncSession, session_ttl: timedelta):
        self.db = db
        self.session_ttl = session_ttl

    async def register(self, req: RegisterRequest, *, allowed: bool) -> User:
        if not allowed:
            raise ForbiddenError("Registration is disabled on this backend", code="registration_disabled")
        existing = await self.db.scalar(select(User.id).where(User.email == req.email))
        if existing is not None:
            raise ConflictError("An account with this email already exists", code="email_taken")
        user = User(email=req.email, username=req.username, hashed_password=hash_password(req.password))
        self.db.add(user)
        try:
            await self.db.flush()
        except IntegrityError as exc:  # concurrent registration with the same email
            raise ConflictError("An account with this email already exists", code="email_taken") from exc
        log.info("user_registered", extra={"user_id": user.id})
        return user

    async def login(self, req: LoginRequest) -> User:
        user = await self.db.scalar(select(User).where(User.email == req.email))
        # verify_password runs even for unknown emails so timing does not reveal accounts.
        if not verify_password(req.password, user.hashed_password if user else None) or user is None:
            raise AuthError("Invalid email or password", code="invalid_credentials")
        if user.hashed_password and password_needs_rehash(user.hashed_password):
            user.hashed_password = hash_password(req.password)
        return user

    async def create_session(self, user: User, user_agent: str | None) -> tuple[str, datetime]:
        token = new_session_token()
        expires_at = utcnow() + self.session_ttl
        self.db.add(
            AuthSession(
                user_id=user.id,
                token_hash=hash_token(token),
                expires_at=expires_at,
                user_agent=(user_agent or "")[:255] or None,
            )
        )
        await self.db.flush()
        return token, expires_at

    async def authenticate(self, token: str) -> User:
        session = await self.db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        now = utcnow()
        if session is None or session.revoked_at is not None or session.expires_at <= now:
            raise AuthError("Session is invalid or has expired", code="invalid_session")
        if session.last_used_at is None or now - session.last_used_at > _TOUCH_INTERVAL:
            session.last_used_at = now
        user = await self.db.get(User, session.user_id)
        if user is None:
            raise AuthError("Session is invalid or has expired", code="invalid_session")
        return user

    async def logout(self, token: str) -> None:
        session = await self.db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        if session is not None and session.revoked_at is None:
            session.revoked_at = utcnow()
