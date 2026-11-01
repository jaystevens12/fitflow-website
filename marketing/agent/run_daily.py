"""Daily run of the LinkedIn head-of-marketing agent.

1. Research: Claude searches the web for this week's market-relevant news.
2. Write: Claude writes your private market briefing and today's LinkedIn post.
3. Publish: post to LinkedIn (auto mode) or open a draft for approval (review mode).
4. Report: a GitHub issue with the briefing and the post, so you get it by email.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import anthropic
import yaml
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))
import github_issues  # noqa: E402
import linkedin  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]  # marketing/
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_CONTINUATIONS = 5


# ---------- structured output ----------

class SelfReview(BaseModel):
    facts_supported: bool = Field(description="Every number, date and claim about the market in the post is backed by a source in the research.")
    confidentiality_ok: bool = Field(description="No client names, sites or figures marked (private) are disclosed.")
    on_voice: bool = Field(description="Matches the voice and off-limits rules in the profile.")
    issues: str = Field(description="Anything a careful editor would flag. Empty string if none.")


class DailyOutput(BaseModel):
    briefing_markdown: str = Field(description="Private market briefing for the owner, in Markdown.")
    pillar: str
    topic: str = Field(description="One-line summary of what the post is about.")
    post_text: str = Field(description="The LinkedIn post exactly as it should appear, hashtags at the end.")
    sources: list[str] = Field(description="URLs the post relies on. Empty only if the post makes no market claims.")
    activity_used: list[str] = Field(description="Activity-log lines the post draws on, copied verbatim.")
    self_review: SelfReview


# ---------- helpers ----------

def read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def load_history(n: int = 21) -> list[dict]:
    lines = [l for l in read(ROOT / "history.jsonl").splitlines() if l.strip()]
    return [json.loads(l) for l in lines[-n:]]


def append_history(entry: dict) -> None:
    with open(ROOT / "history.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def add_today_note(note: str, today: dt.date) -> None:
    """Insert a note from the 'Run workflow' form at the top of the activity log."""
    path = ROOT / "activity.md"
    text = read(path)
    entry = f"- {today.isoformat()}: {note.strip()}\n"
    marker = "Format: `- YYYY-MM-DD: what happened`\n"
    if marker in text:
        text = text.replace(marker, marker + "\n" + entry, 1)
    else:
        text = text + "\n" + entry
    path.write_text(text, encoding="utf-8")


def text_of(message) -> str:
    return "\n".join(b.text for b in message.content if b.type == "text").strip()


def check_refusal(message, step: str) -> None:
    if message.stop_reason == "refusal":
        detail = getattr(message, "stop_details", None)
        raise RuntimeError(f"{step}: model declined ({getattr(detail, 'category', None)}).")


# ---------- step 1: research ----------

RESEARCH_SYSTEM = """You are the research desk for the head of marketing at a South African solar and battery company.
Find what actually moved in the market in the last 7 days, verify it, and report it plainly.
Prefer primary and reputable sources: NERSA, Eskom, DMRE/DEE, IPP Office, SAPVIA, ESASA, Engineering News,
Moneyweb, BusinessDay, News24 Business, Daily Maverick, ESI Africa, pv magazine, Energy-Storage.news, BloombergNEF, IEA.
Never invent a statistic. If something is unconfirmed, say so."""


def research(client: anthropic.Anthropic, cfg: dict, today: dt.date, pillar: dict) -> str:
    market = cfg["market"]
    prompt = f"""Today is {today:%A %d %B %Y}.

Market focus: {market['focus']}

Today's content pillar is "{pillar['name']}": {pillar['brief']}

Search the web and produce a research brief with:
1. The 5 to 8 most significant developments from the past 7 days, each with: what happened, date,
   why it matters to SA solar/battery buyers or installers, and the source URL.
2. Two or three live debates or open questions in the industry right now.
3. Any hard numbers (tariff increases, prices, capacity, deal sizes) with their source URL.
4. One development that best suits today's pillar, and why."""

    tools = [{
        "type": "web_search_20260209",
        "name": "web_search",
        "max_uses": 12,
        "user_location": {"type": "approximate", "country": market["country_code"], "timezone": market["timezone"]},
    }]
    messages = [{"role": "user", "content": prompt}]
    for _ in range(MAX_CONTINUATIONS):
        with client.beta.messages.stream(
            model=cfg["model"],
            max_tokens=32000,
            system=RESEARCH_SYSTEM,
            tools=tools,
            messages=messages,
            output_config={"effort": cfg.get("effort", "high")},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        ) as stream:
            msg = stream.get_final_message()
        check_refusal(msg, "Research")
        if msg.stop_reason != "pause_turn":
            return text_of(msg)
        messages = [messages[0], {"role": "assistant", "content": msg.content}]
    return text_of(msg)


# ---------- step 2: write ----------

WRITER_SYSTEM = """You are the head of marketing for a South African solar and battery business, running the owner's
personal LinkedIn. Your job: build the owner's reputation as a credible, well-informed practitioner, keep them
informed about the market, and start useful conversations with the right people.

Standards for every post:
- Written in the owner's voice, first person, following the profile exactly (spelling, tone, off-limits list).
- One idea per post. A first line that earns the click without clickbait. 120 to 220 words. Short paragraphs.
- Market claims come only from the research brief, with the figure stated accurately. If the brief doesn't
  support a claim, leave it out. Never invent projects, clients, numbers or quotes.
- Personal stories come only from the activity log. Anything marked (private) may be described in general
  terms only: no client names, locations or exact figures.
- If the activity log is empty or stale for an "in the field" style pillar, write a perspective post on a
  research item instead of making something up.
- Don't repeat the angle or opening of any recent post.
- Plain text only (LinkedIn does not render Markdown). Hashtags on the last line, within the limit given.
- If the post relies on a source, mention the source by name in the text (e.g. "per NERSA's decision")
  rather than pasting a URL; URLs go in the sources field.

The briefing is private, for the owner only. Make it the thing they'd want to read with their morning coffee:
## Top stories (3 to 5 bullets: what happened, why it matters to us, link)
## What it means for STS Tech Group (concrete implications or opportunities)
## Talking points (2 or 3 lines they could use in a client meeting today)
## Worth watching (upcoming decisions, dates, consultations)

Then review the post honestly as a strict editor and fill in self_review."""


def write(client, cfg, today, pillar, research_brief, profile, activity, history) -> DailyOutput:
    recent = "\n".join(f"- {h['date']} [{h.get('pillar','')}] {h.get('topic','')}" for h in history) or "(none yet)"
    hashtags = cfg.get("hashtags", {})
    prompt = f"""Today is {today:%A %d %B %Y}. Pillar: "{pillar['name']}": {pillar['brief']}
Hashtags: at most {hashtags.get('max', 4)}, preferably from {', '.join(hashtags.get('pool', []))}.

<profile>
{profile}
</profile>

<activity_log>
{activity}
</activity_log>

<recent_posts>
{recent}
</recent_posts>

<research_brief>
{research_brief}
</research_brief>

Write today's briefing and LinkedIn post."""

    msg = client.beta.messages.parse(
        model=cfg["model"],
        max_tokens=16000,
        system=WRITER_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_format=DailyOutput,
        output_config={"effort": cfg.get("effort", "high")},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    )
    check_refusal(msg, "Writing")
    if msg.parsed_output is None:
        raise RuntimeError(f"Writing: no structured output (stop_reason={msg.stop_reason}).")
    return msg.parsed_output


# ---------- step 3/4: publish + report ----------

def token_expiry_warning(today: dt.date) -> str:
    exp = os.environ.get("LINKEDIN_TOKEN_EXPIRES", "").strip()
    if not exp:
        return ""
    try:
        days = (dt.date.fromisoformat(exp) - today).days
    except ValueError:
        return ""
    if days <= 7:
        return (f"\n> ⚠️ Your LinkedIn token expires in {max(days, 0)} day(s) ({exp}). "
                "Run `python marketing/agent/get_linkedin_token.py` and update the secret.\n")
    return ""


def main() -> int:
    cfg = yaml.safe_load(read(ROOT / "config.yml"))
    tz = ZoneInfo(cfg["market"]["timezone"])
    today = dt.datetime.now(tz).date()

    if note := os.environ.get("TODAY_NOTE", "").strip():
        add_today_note(note, today)

    pillar = cfg["pillars"][today.weekday()]
    is_post_day = today.weekday() in cfg.get("post_days", list(range(7)))
    mode = os.environ.get("PUBLISH_MODE_OVERRIDE") or cfg.get("publish_mode", "auto")
    dry_run = os.environ.get("DRY_RUN", "").lower() == "true"

    client = anthropic.Anthropic()
    print(f"[{today}] Pillar: {pillar['name']} | mode: {mode} | post day: {is_post_day}")

    brief = research(client, cfg, today, pillar)
    out = write(client, cfg, today, pillar, brief, read(ROOT / "profile.md"),
                read(ROOT / "activity.md"), load_history())

    (ROOT / "briefings" / f"{today.isoformat()}.md").write_text(
        f"# Market briefing, {today:%A %d %B %Y}\n\n{out.briefing_markdown}\n\n"
        f"---\n\n## Research notes\n\n{brief}\n", encoding="utf-8")

    review = out.self_review
    passed = review.facts_supported and review.confidentiality_ok and review.on_voice
    status, post_url, reason = "draft", "", ""

    if not is_post_day:
        status, reason = "briefing_only", "Today is not a posting day."
    elif dry_run:
        reason = "Dry run: nothing was posted."
    elif mode != "auto":
        reason = "Review mode: add the `approve-post` label to publish."
    elif not passed:
        reason = f"Held for your review: the editor check flagged it. {review.issues}"
    elif not os.environ.get("LINKEDIN_ACCESS_TOKEN"):
        reason = "No LINKEDIN_ACCESS_TOKEN secret set yet, so this is saved as a draft."
    else:
        try:
            post_url = linkedin.publish(out.post_text)
            status = "published"
        except linkedin.LinkedInError as e:
            reason = (f"LinkedIn rejected the post ({e.status}). "
                      + ("Your token has probably expired: run `python marketing/agent/get_linkedin_token.py`, "
                         "update the secret, then add the `approve-post` label." if e.status in (401, 403) else str(e)))

    sources = "\n".join(f"- {s}" for s in out.sources) or "- (none)"
    header = {"published": f"✅ **Posted to LinkedIn:** {post_url}",
              "draft": f"📝 **Draft, not posted.** {reason}",
              "briefing_only": f"📰 {reason} Here's your briefing."}[status]

    body = f"""{header}
{token_expiry_warning(today)}
## Today's post: {out.pillar}
_{out.topic}_

{github_issues.POST_START}
{out.post_text}
{github_issues.POST_END}

**Sources:**
{sources}

**Editor check:** facts {'✅' if review.facts_supported else '❌'} · confidentiality {'✅' if review.confidentiality_ok else '❌'} · voice {'✅' if review.on_voice else '❌'}{(' · ' + review.issues) if review.issues else ''}

---

{out.briefing_markdown}
"""
    if status == "draft":
        body += "\n---\n_To publish: edit the post text above if you like (keep the hidden markers), then add the label `approve-post`._\n"

    labels = ["linkedin-agent", {"published": "posted", "draft": "linkedin-draft", "briefing_only": "briefing"}[status]]
    title = f"{today:%a %d %b}: {out.topic}"[:120]
    issue_number = github_issues.create_issue(title, body, labels, close=(status != "draft"))

    append_history({"date": today.isoformat(), "pillar": out.pillar, "topic": out.topic, "status": status,
                    "url": post_url, "issue": issue_number, "text": out.post_text, "sources": out.sources})
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
