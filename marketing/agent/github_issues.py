"""Daily report delivery via GitHub issues (GitHub emails you each one)."""

from __future__ import annotations

import os
import re

import requests

POST_START = "<!-- POST:START -->"
POST_END = "<!-- POST:END -->"
LABEL_COLOURS = {"linkedin-agent": "0A66C2", "posted": "2DA44E", "linkedin-draft": "D4A72C",
                 "briefing": "8250DF", "approve-post": "1F883D"}


def _api() -> tuple[str, dict] | None:
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_TOKEN")
    if not (repo and token):
        return None
    return (f"https://api.github.com/repos/{repo}",
            {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})


def _ensure_labels(base: str, h: dict, labels: list[str]) -> None:
    for name in labels:
        requests.post(f"{base}/labels", headers=h, timeout=30,
                      json={"name": name, "color": LABEL_COLOURS.get(name, "ededed")})  # 422 = exists


def create_issue(title: str, body: str, labels: list[str], close: bool = False) -> int | None:
    api = _api()
    if not api:
        print("(No GITHUB_TOKEN/GITHUB_REPOSITORY: skipping issue creation.)")
        return None
    base, h = api
    _ensure_labels(base, h, labels + ["approve-post"])
    r = requests.post(f"{base}/issues", headers=h, json={"title": title, "body": body, "labels": labels}, timeout=30)
    r.raise_for_status()
    number = r.json()["number"]
    if close:
        requests.patch(f"{base}/issues/{number}", headers=h, json={"state": "closed"}, timeout=30)
    return number


def issue_url(number: int | None) -> str:
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not (number and repo):
        return ""
    return f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/issues/{number}"


def extract_post(body: str) -> str | None:
    m = re.search(re.escape(POST_START) + r"\s*(.*?)\s*" + re.escape(POST_END), body or "", re.S)
    return m.group(1).strip() if m else None


def comment_and_close(number: int, comment: str, close: bool = True, add_labels: list[str] | None = None,
                      remove_label: str | None = None) -> None:
    api = _api()
    if not api:
        return
    base, h = api
    requests.post(f"{base}/issues/{number}/comments", headers=h, json={"body": comment}, timeout=30)
    if add_labels:
        _ensure_labels(base, h, add_labels)
        requests.post(f"{base}/issues/{number}/labels", headers=h, json={"labels": add_labels}, timeout=30)
    if remove_label:
        requests.delete(f"{base}/issues/{number}/labels/{remove_label}", headers=h, timeout=30)
    if close:
        requests.patch(f"{base}/issues/{number}", headers=h, json={"state": "closed"}, timeout=30)
