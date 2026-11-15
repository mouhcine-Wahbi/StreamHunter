from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select, update

from app.models import AuthSession, User
from app.utils.security import hash_token
from tests.conftest import register


async def test_register_returns_session_and_hashes_password(client: httpx.AsyncClient, app) -> None:
    body = await register(client, "Editor@Example.com")
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "editor@example.com"  # normalized
    assert len(body["access_token"]) >= 40
    async with app.state.sessionmaker() as db:
        user = await db.scalar(select(User))
        assert user.hashed_password.startswith("$argon2id$")
        assert "correct horse" not in user.hashed_password
        session = await db.scalar(select(AuthSession))
        # Only the hash of the token is stored.
        assert session.token_hash == hash_token(body["access_token"])
        assert body["access_token"] not in session.token_hash


async def test_duplicate_email_conflicts(client: httpx.AsyncClient) -> None:
    await register(client)
    r = await client.post(
        "/api/v1/auth/register", json={"email": "editor@example.com", "username": "x2", "password": "another password"}
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "email_taken"


async def test_register_validation(client: httpx.AsyncClient) -> None:
    r = await client.post("/api/v1/auth/register", json={"email": "nope", "username": "a", "password": "short"})
    assert r.status_code == 422
    body = r.json()["error"]
    assert body["code"] == "validation_error"
    assert {tuple(e["loc"])[-1] for e in body["details"]["errors"]} >= {"email", "username", "password"}


async def test_login_me_logout(client: httpx.AsyncClient) -> None:
    await register(client)
    r = await client.post("/api/v1/auth/login", json={"email": "EDITOR@example.com", "password": "correct horse battery"})
    assert r.status_code == 200
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}

    me = await client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200 and me.json()["username"] == "editor"

    assert (await client.post("/api/v1/auth/logout", headers=headers)).status_code == 204
    after = await client.get("/api/v1/auth/me", headers=headers)
    assert after.status_code == 401
    assert after.json()["error"]["code"] == "invalid_session"


async def test_login_wrong_password_and_unknown_user_look_identical(client: httpx.AsyncClient) -> None:
    await register(client)
    wrong = await client.post("/api/v1/auth/login", json={"email": "editor@example.com", "password": "wrong password!"})
    unknown = await client.post("/api/v1/auth/login", json={"email": "ghost@example.com", "password": "wrong password!"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


async def test_protected_routes_require_a_valid_token(client: httpx.AsyncClient) -> None:
    for path in ("/api/v1/auth/me", "/api/v1/streamers", "/api/v1/highlights", "/api/v1/settings"):
        r = await client.get(path)
        assert r.status_code == 401, path
        assert r.headers["www-authenticate"] == "Bearer"
    r = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401


async def test_expired_session_is_rejected(client: httpx.AsyncClient, app) -> None:
    body = await register(client)
    async with app.state.sessionmaker() as db:
        await db.execute(update(AuthSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await db.commit()
    r = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert r.status_code == 401


async def test_registration_can_be_disabled(client: httpx.AsyncClient, app) -> None:
    app.state.settings.allow_registration = False
    r = await client.post(
        "/api/v1/auth/register", json={"email": "a@example.com", "username": "aa", "password": "long enough pw"}
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "registration_disabled"


async def test_login_is_rate_limited(client: httpx.AsyncClient, app) -> None:
    from app.utils.rate_limit import SlidingWindowLimiter

    app.state.auth_limiter = SlidingWindowLimiter(3, 60)
    codes = [
        (await client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": "whatever"})).status_code
        for _ in range(5)
    ]
    assert codes == [401, 401, 401, 429, 429]
