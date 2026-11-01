"""Minimal LinkedIn Posts API client for posting as a member (w_member_social)."""

from __future__ import annotations

import datetime as dt
import os
import re

import requests

API = "https://api.linkedin.com"

# Characters LinkedIn's "little text" format treats as markup in post commentary.
_RESERVED = re.compile(r"([\\|{}@\[\]()<>#*_~])")
_HASHTAG = re.compile(r"(?<![\w#])#([A-Za-z][A-Za-z0-9_]*)")


class LinkedInError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"LinkedIn API {status}: {body[:500]}")
        self.status = status


def _api_version() -> str:
    """LinkedIn versions are YYYYMM; last month's is always live."""
    if v := os.environ.get("LINKEDIN_API_VERSION"):
        return v
    first = dt.date.today().replace(day=1)
    return (first - dt.timedelta(days=1)).strftime("%Y%m")


def to_little_text(text: str) -> str:
    """Escape reserved characters and turn #Tags into clickable hashtags."""
    out, last = [], 0
    for m in _HASHTAG.finditer(text):
        out.append(_RESERVED.sub(r"\\\1", text[last : m.start()]))
        out.append("{hashtag|\\#|" + m.group(1) + "}")
        last = m.end()
    out.append(_RESERVED.sub(r"\\\1", text[last:]))
    return "".join(out)


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "LinkedIn-Version": _api_version(),
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }


def person_urn(token: str) -> str:
    if urn := os.environ.get("LINKEDIN_PERSON_URN"):
        return urn
    r = requests.get(f"{API}/v2/userinfo", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code != 200:
        raise LinkedInError(r.status_code, r.text)
    return f"urn:li:person:{r.json()['sub']}"


def publish(text: str, token: str | None = None) -> str:
    """Publish a text post and return its URL."""
    token = token or os.environ["LINKEDIN_ACCESS_TOKEN"]
    body = {
        "author": person_urn(token),
        "commentary": to_little_text(text),
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    r = requests.post(f"{API}/rest/posts", json=body, headers=_headers(token), timeout=30)
    if r.status_code not in (200, 201):
        raise LinkedInError(r.status_code, r.text)
    post_id = r.headers.get("x-restli-id") or r.headers.get("x-linkedin-id", "")
    return f"https://www.linkedin.com/feed/update/{post_id}/" if post_id else "https://www.linkedin.com/feed/"
