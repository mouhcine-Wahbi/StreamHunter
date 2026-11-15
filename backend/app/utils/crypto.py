"""Encryption at rest for platform OAuth tokens (Fernet: AES-128-CBC + HMAC-SHA256)."""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken


class TokenCipherUnavailable(RuntimeError):
    pass


class TokenCipher:
    def __init__(self, key: str | None):
        self._fernet: Fernet | None = None
        if key:
            try:
                self._fernet = Fernet(key.encode())
            except (ValueError, TypeError) as exc:
                raise ValueError("TOKEN_ENCRYPTION_KEY is not a valid Fernet key") from exc

    @property
    def available(self) -> bool:
        return self._fernet is not None

    def encrypt(self, plaintext: str) -> str:
        if self._fernet is None:
            raise TokenCipherUnavailable("TOKEN_ENCRYPTION_KEY is not configured; refusing to store tokens")
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str) -> str:
        if self._fernet is None:
            raise TokenCipherUnavailable("TOKEN_ENCRYPTION_KEY is not configured")
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise ValueError("Stored token could not be decrypted (wrong key or corrupted data)") from exc
