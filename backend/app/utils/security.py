from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_hasher = PasswordHasher()  # Argon2id with library-recommended parameters

# Verifying against this when the user does not exist keeps login timing uniform.
_DUMMY_HASH = _hasher.hash("streamhunter-timing-equalizer")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str | None) -> bool:
    try:
        return _hasher.verify(hashed or _DUMMY_HASH, password) and hashed is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(hashed: str) -> bool:
    return _hasher.check_needs_rehash(hashed)


def new_session_token() -> str:
    """256-bit random bearer token, URL-safe."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    # Tokens are high-entropy random values, so a fast hash is appropriate here.
    return hashlib.sha256(token.encode()).hexdigest()
