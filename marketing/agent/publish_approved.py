"""Publish a draft when you add the `approve-post` label to its issue."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import github_issues  # noqa: E402
import linkedin  # noqa: E402

HISTORY = Path(__file__).resolve().parents[1] / "history.jsonl"


def mark_published(issue: int, url: str, text: str) -> None:
    if not HISTORY.exists():
        return
    rows = [json.loads(l) for l in HISTORY.read_text(encoding="utf-8").splitlines() if l.strip()]
    for row in rows:
        if row.get("issue") == issue:
            row.update(status="published", url=url, text=text)
    HISTORY.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def main() -> int:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    issue = event["issue"]
    number = issue["number"]
    labels = {l["name"] for l in issue.get("labels", [])}
    if "posted" in labels:
        print("Already posted; nothing to do.")
        return 0

    text = github_issues.extract_post(issue.get("body", ""))
    if not text:
        github_issues.comment_and_close(number, "❌ Couldn't find the post between the hidden "
                                        "`POST:START`/`POST:END` markers, so nothing was posted.",
                                        close=False, remove_label="approve-post")
        return 1

    try:
        url = linkedin.publish(text)
    except linkedin.LinkedInError as e:
        hint = (" Your LinkedIn token has probably expired: run `python marketing/agent/get_linkedin_token.py`, "
                "update the secret, then re-add the label." if e.status in (401, 403) else "")
        github_issues.comment_and_close(number, f"❌ LinkedIn rejected the post: {e}.{hint}",
                                        close=False, remove_label="approve-post")
        return 1

    mark_published(number, url, text)
    github_issues.comment_and_close(number, f"✅ Posted to LinkedIn: {url}", add_labels=["posted"],
                                    remove_label="linkedin-draft")
    return 0


if __name__ == "__main__":
    sys.exit(main())
