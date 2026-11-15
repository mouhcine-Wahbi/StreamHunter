"""In-memory fakes of the Twitch and Kick HTTP APIs for httpx.MockTransport.

Response shapes follow the field sources documented in app/integrations/*/schemas.py.
They are test fixtures, clearly separate from application code; nothing here is
used outside the automated tests.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from urllib.parse import parse_qs

import httpx


def _json(body: object, status: int = 200, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


@dataclass
class FakeTwitch:
    client_id: str = "tw-client"
    users: dict[str, dict] = field(
        default_factory=lambda: {
            "streamerone": {"id": "101", "login": "streamerone", "display_name": "StreamerOne", "profile_image_url": "https://static-cdn.example/101.png"},
            "quietone": {"id": "102", "login": "quietone", "display_name": "QuietOne", "profile_image_url": ""},
        }
    )
    live: dict[str, dict] = field(
        default_factory=lambda: {
            "101": {"user_id": "101", "user_login": "streamerone", "type": "live", "title": "Ranked grind", "game_name": "Valorant", "viewer_count": 4321, "started_at": "2026-11-15T05:00:00Z"}
        }
    )
    app_tokens_issued: int = 0
    reject_next_app_token_use: bool = False
    requests: list[httpx.Request] = field(default_factory=list)
    user_token_scopes: list[str] = field(default_factory=lambda: ["clips:edit", "user:read:chat"])
    revoked: list[str] = field(default_factory=list)
    # Create Clip simulation: a clip becomes visible after `clip_ready_after` Get Clips polls.
    clip_ready_after: int = 1
    clips_requested: list[dict] = field(default_factory=list)
    clip_polls: dict[str, int] = field(default_factory=dict)

    def handler(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        url, path = req.url, req.url.path
        if url.host == "id.twitch.tv":
            form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()} if req.content else {}
            if path == "/oauth2/token":
                if form.get("client_secret") != "tw-secret":
                    return _json({"status": 403, "message": "invalid client secret"}, 403)
                if form["grant_type"] == "client_credentials":
                    self.app_tokens_issued += 1
                    return _json({"access_token": f"app-{self.app_tokens_issued}", "expires_in": 5000000, "token_type": "bearer"})
                if form["grant_type"] == "authorization_code":
                    if form.get("code") != "good-code":
                        return _json({"status": 400, "message": "Invalid authorization code"}, 400)
                    return _json({"access_token": "user-at", "refresh_token": "user-rt", "expires_in": 14000, "scope": self.user_token_scopes, "token_type": "bearer"})
                if form["grant_type"] == "refresh_token":
                    if form.get("refresh_token") != "user-rt":
                        return _json({"status": 400, "message": "Invalid refresh token"}, 400)
                    return _json({"access_token": "user-at-2", "refresh_token": "user-rt-2", "expires_in": 14000, "scope": self.user_token_scopes})
            if path == "/oauth2/validate":
                if req.headers.get("Authorization") in ("OAuth user-at", "OAuth user-at-2"):
                    return _json({"client_id": self.client_id, "login": "editorlogin", "user_id": "9001", "scopes": self.user_token_scopes, "expires_in": 14000})
                return _json({"status": 401, "message": "invalid access token"}, 401)
            if path == "/oauth2/revoke":
                self.revoked.append(form.get("token", ""))
                return httpx.Response(200)
        if url.host == "api.twitch.tv" and url.path == "/helix/clips" and req.method == "POST":
            if req.headers.get("Authorization") not in ("Bearer user-at", "Bearer user-at-2") or req.headers.get("Client-Id") != self.client_id:
                return _json({"error": "Unauthorized", "status": 401}, 401)
            bid = url.params["broadcaster_id"]
            if bid not in self.live:
                return _json({"error": "Not Found", "status": 404, "message": "Clipping is not possible for an offline channel."}, 404)
            cid = f"Clip{len(self.clips_requested) + 1}"
            self.clips_requested.append({"id": cid, "broadcaster_id": bid, "has_delay": url.params.get("has_delay")})
            return _json({"data": [{"id": cid, "edit_url": f"https://clips.twitch.tv/{cid}/edit"}]}, 202)
        if url.host == "api.twitch.tv":
            auth = req.headers.get("Authorization", "")
            if req.headers.get("Client-Id") != self.client_id or not auth.startswith("Bearer app-"):
                return _json({"error": "Unauthorized", "status": 401}, 401)
            if self.reject_next_app_token_use:
                self.reject_next_app_token_use = False
                return _json({"error": "Unauthorized", "status": 401, "message": "Invalid OAuth token"}, 401)
            q = parse_qs(url.query.decode())
            if path == "/helix/users":
                logins = q.get("login", [])
                ids = q.get("id", [])
                data = [u for u in self.users.values() if u["login"] in logins or u["id"] in ids]
                return _json({"data": data})
            if path == "/helix/streams":
                ids = q.get("user_id", [])
                assert len(ids) <= 100, "Helix allows at most 100 user_id values"
                return _json({"data": [s for uid, s in self.live.items() if uid in ids], "pagination": {}})
            if path == "/helix/clips":
                cid = q["id"][0]
                self.clip_polls[cid] = self.clip_polls.get(cid, 0) + 1
                known = any(c["id"] == cid for c in self.clips_requested)
                if not known or self.clip_polls[cid] < self.clip_ready_after:
                    return _json({"data": [], "pagination": {}})
                return _json({"data": [{"id": cid, "url": f"https://clips.twitch.tv/{cid}", "title": "Ranked grind",
                                        "duration": 30.0, "thumbnail_url": "https://clips-media.example/x.jpg"}]})
            if path == "/helix/search/channels":
                term = q["query"][0].lower()
                data = []
                for u in self.users.values():
                    if term in u["login"]:
                        s = self.live.get(u["id"])
                        data.append({
                            "id": u["id"], "broadcaster_login": u["login"], "display_name": u["display_name"],
                            "is_live": s is not None, "title": s["title"] if s else "Old title",
                            "game_name": s["game_name"] if s else "Old category",
                            "thumbnail_url": u["profile_image_url"], "started_at": s["started_at"] if s else "",
                        })
                return _json({"data": data, "pagination": {}})
        return _json({"error": "not found"}, 404)


@dataclass
class FakeKick:
    channels: dict[str, dict] = field(
        default_factory=lambda: {
            "kickstar": {
                "broadcaster_user_id": 501, "slug": "kickstar", "stream_title": "IRL late night",
                "category": {"id": 15, "name": "IRL"},
                "stream": {"is_live": True, "viewer_count": 2100, "start_time": "2026-11-15T04:30:00Z"},
            },
            "sleepy": {
                "broadcaster_user_id": 502, "slug": "sleepy", "stream_title": "",
                "category": {"id": 15, "name": "IRL"},
                "stream": {"is_live": False, "viewer_count": 0, "start_time": "0001-01-01T00:00:00Z"},
            },
        }
    )
    users: dict[int, dict] = field(
        default_factory=lambda: {
            501: {"user_id": 501, "name": "KickStar", "profile_picture": "https://files.kick.example/501.webp"},
            502: {"user_id": 502, "name": "Sleepy", "profile_picture": None},
        }
    )
    requests: list[httpx.Request] = field(default_factory=list)
    last_token_form: dict[str, str] = field(default_factory=dict)
    malformed: bool = False
    public_key_pem: str = ""
    subscriptions: dict[str, dict] = field(default_factory=dict)
    deleted_subscriptions: list[str] = field(default_factory=list)

    def handler(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        url, path = req.url, req.url.path
        if url.host == "id.kick.com":
            form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()} if req.content else {}
            if path == "/oauth/token":
                self.last_token_form = form
                if form.get("client_secret") != "kick-secret":
                    return _json({"error": "invalid client"}, 401)
                if form["grant_type"] == "client_credentials":
                    return _json({"access_token": "kick-app", "token_type": "Bearer", "expires_in": 3600})
                if form["grant_type"] == "authorization_code":
                    if not form.get("code_verifier"):
                        return _json({"error": "Invalid request"}, 400)
                    return _json({"access_token": "kick-user-at", "refresh_token": "kick-user-rt", "expires_in": "7200", "scope": "user:read channel:read events:subscribe", "token_type": "Bearer"})
            if path == "/oauth/revoke":
                return httpx.Response(200)
        if url.host == "api.kick.com":
            auth = req.headers.get("Authorization", "")
            q = parse_qs(url.query.decode())
            if self.malformed:
                return _json({"data": [{"slug": "missing-id"}], "message": "OK"})
            if path == "/public/v1/public-key":
                return _json({"data": {"public_key": self.public_key_pem}, "message": "OK"})
            if path == "/public/v1/events/subscriptions" and auth == "Bearer kick-app":
                if req.method == "POST":
                    body = json.loads(req.content)
                    sid = f"sub-{len(self.subscriptions) + 1}"
                    self.subscriptions[sid] = body
                    return _json({"data": [{"name": e["name"], "version": e["version"], "subscription_id": sid, "error": None}
                                           for e in body["events"]], "message": "OK"})
                if req.method == "DELETE":
                    self.deleted_subscriptions += q.get("id", [])
                    return httpx.Response(204)
            if path == "/public/v1/channels" and auth == "Bearer kick-app":
                if "slug" in q:
                    data = [self.channels[s] for s in q["slug"] if s in self.channels]
                else:
                    ids = {int(x) for x in q.get("broadcaster_user_id", [])}
                    data = [c for c in self.channels.values() if c["broadcaster_user_id"] in ids]
                return _json({"data": data, "message": "OK"})
            if path == "/public/v1/users":
                if auth == "Bearer kick-user-at" and "id" not in q:
                    return _json({"data": [{"user_id": 777, "name": "EditorOnKick", "email": "x@example.com"}], "message": "OK"})
                if auth == "Bearer kick-app":
                    ids = {int(x) for x in q.get("id", [])}
                    return _json({"data": [u for k, u in self.users.items() if k in ids], "message": "OK"})
            return _json({"message": "Unauthorized"}, 401)
        return _json({"error": "not found"}, 404)


def transport(handler) -> httpx.MockTransport:  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


def body_json(req: httpx.Request) -> object:
    return json.loads(req.content)
