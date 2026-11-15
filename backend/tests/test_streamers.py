from __future__ import annotations

import httpx
from sqlalchemy import func, select

from app.models import Streamer, UserStreamer
from tests.conftest import register


async def add(client: httpx.AsyncClient, headers: dict, platform: str = "twitch", username: str = "alpha") -> httpx.Response:
    return await client.post("/api/v1/streamers", json={"platform": platform, "username": username}, headers=headers)


async def test_search_uses_the_platform_adapter(client, auth_headers, fake_twitch) -> None:
    r = await client.get("/api/v1/streamers/search", params={"platform": "twitch", "username": "alp"}, headers=auth_headers)
    assert r.status_code == 200
    assert [x["username"] for x in r.json()] == ["alpha"]
    assert r.json()[0]["is_live"] is True
    assert ("search", "alp") in fake_twitch.calls


async def test_search_validates_input(client, auth_headers) -> None:
    bad_platform = await client.get("/api/v1/streamers/search", params={"platform": "youtube", "username": "x1"}, headers=auth_headers)
    bad_name = await client.get("/api/v1/streamers/search", params={"platform": "kick", "username": "<script>"}, headers=auth_headers)
    assert bad_platform.status_code == bad_name.status_code == 422


async def test_add_list_get_update_delete(client, auth_headers, app) -> None:
    r = await add(client, auth_headers)
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["platform"] == "twitch" and s["platform_user_id"] == "1001" and s["monitoring_enabled"] is True
    assert s["is_live"] is True and s["current_category"] == "Just Chatting"

    page = (await client.get("/api/v1/streamers", headers=auth_headers)).json()
    assert page["total"] == 1 and page["items"][0]["id"] == s["id"]

    assert (await client.get(f"/api/v1/streamers/{s['id']}", headers=auth_headers)).json()["username"] == "alpha"

    upd = await client.patch(f"/api/v1/streamers/{s['id']}", json={"monitoring_enabled": False}, headers=auth_headers)
    assert upd.status_code == 200 and upd.json()["monitoring_enabled"] is False
    async with app.state.sessionmaker() as db:
        assert (await db.get(Streamer, s["id"])).monitoring_enabled is False  # aggregate follows

    assert (await client.delete(f"/api/v1/streamers/{s['id']}", headers=auth_headers)).status_code == 204
    assert (await client.get(f"/api/v1/streamers/{s['id']}", headers=auth_headers)).status_code == 404


async def test_no_duplicates(client, auth_headers, app) -> None:
    assert (await add(client, auth_headers)).status_code == 201
    dup = await add(client, auth_headers, username="ALPHA")
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "already_in_watchlist"
    # Same username on another platform is a different streamer.
    assert (await add(client, auth_headers, platform="kick")).status_code == 201
    async with app.state.sessionmaker() as db:
        assert await db.scalar(select(func.count()).select_from(Streamer)) == 2


async def test_streamer_rows_are_shared_between_users_but_watchlists_are_not(client, auth_headers, app) -> None:
    mine = (await add(client, auth_headers)).json()
    other = {"Authorization": f"Bearer {(await register(client, 'other@example.com'))['access_token']}"}
    theirs = (await add(client, other)).json()
    assert mine["id"] == theirs["id"]
    async with app.state.sessionmaker() as db:
        assert await db.scalar(select(func.count()).select_from(Streamer)) == 1
        assert await db.scalar(select(func.count()).select_from(UserStreamer)) == 2

    # Aggregate monitoring stays on while at least one user monitors.
    await client.patch(f"/api/v1/streamers/{mine['id']}", json={"monitoring_enabled": False}, headers=auth_headers)
    async with app.state.sessionmaker() as db:
        assert (await db.get(Streamer, mine["id"])).monitoring_enabled is True

    # Removing it from one watchlist does not affect the other.
    await client.delete(f"/api/v1/streamers/{mine['id']}", headers=auth_headers)
    assert (await client.get(f"/api/v1/streamers/{mine['id']}", headers=other)).status_code == 200


async def test_cannot_touch_another_users_entry(client, auth_headers) -> None:
    other = {"Authorization": f"Bearer {(await register(client, 'other@example.com'))['access_token']}"}
    theirs = (await add(client, other, username="bravo")).json()
    for method, kwargs in (("GET", {}), ("PATCH", {"json": {"is_favorite": True}}), ("DELETE", {})):
        r = await client.request(method, f"/api/v1/streamers/{theirs['id']}", headers=auth_headers, **kwargs)
        assert r.status_code == 404, method
    assert (await client.get(f"/api/v1/streamers/{theirs['id']}", headers=other)).status_code == 200


async def test_unknown_channel_is_404(client, auth_headers) -> None:
    r = await add(client, auth_headers, username="nobody")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "channel_not_found"


async def test_patch_requires_a_field(client, auth_headers) -> None:
    s = (await add(client, auth_headers)).json()
    r = await client.patch(f"/api/v1/streamers/{s['id']}", json={}, headers=auth_headers)
    assert r.status_code == 422


async def test_live_and_status_endpoints(client, auth_headers) -> None:
    alpha = (await add(client, auth_headers)).json()
    await add(client, auth_headers, username="bravo")
    live = (await client.get("/api/v1/streams/live", headers=auth_headers)).json()
    assert live["total"] == 1 and live["items"][0]["username"] == "alpha"
    status = (await client.get(f"/api/v1/streams/{alpha['id']}/status", headers=auth_headers)).json()
    assert status["is_live"] is True and status["category"] == "Just Chatting"
    # Never checked by monitoring yet: reported honestly as null.
    assert status["last_checked_at"] is None


async def test_pagination(client, auth_headers) -> None:
    await add(client, auth_headers)
    await add(client, auth_headers, username="bravo")
    p = (await client.get("/api/v1/streamers", params={"limit": 1, "offset": 1}, headers=auth_headers)).json()
    assert p["total"] == 2 and len(p["items"]) == 1 and p["limit"] == 1 and p["offset"] == 1
    assert (await client.get("/api/v1/streamers", params={"limit": 500}, headers=auth_headers)).status_code == 422
