"""Sends the morning email (today's post + briefing) through Gmail."""

from __future__ import annotations

import html
import os
import smtplib
from email.message import EmailMessage

import markdown


def send(to: str, subject: str, status_line: str, post_text: str, sources: list[str],
         briefing_md: str, action_url: str = "", action_label: str = "") -> bool:
    sender = os.environ.get("GMAIL_ADDRESS") or to
    password = os.environ.get("GMAIL_APP_PASSWORD")
    if not password:
        print("(No GMAIL_APP_PASSWORD secret set: skipping email.)")
        return False

    src_txt = "\n".join(f"- {s}" for s in sources) or "- (none)"
    action_txt = f"\n{action_label}: {action_url}\n" if action_url else ""
    plain = (f"{status_line}\n{action_txt}\nTODAY'S POST\n------------\n{post_text}\n\n"
             f"Sources:\n{src_txt}\n\nYOUR BRIEFING\n-------------\n{briefing_md}\n")

    src_html = "".join(f'<li><a href="{html.escape(s)}">{html.escape(s)}</a></li>' for s in sources) or "<li>(none)</li>"
    button = (f'<p><a href="{html.escape(action_url)}" style="display:inline-block;background:#0B2545;color:#fff;'
              f'padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:600">{html.escape(action_label)}</a></p>'
              if action_url else "")
    rich = f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#3F4B5C;max-width:640px;margin:auto;line-height:1.55">
<div style="height:4px;width:96px;background:linear-gradient(90deg,#0B2545,#0089AD);border-radius:2px"></div>
<p style="font-size:15px;color:#0E1B2E"><b>{html.escape(status_line)}</b></p>{button}
<h2 style="font-family:Georgia,serif;color:#0E1B2E;font-size:20px;margin:24px 0 8px">Today's post</h2>
<div style="white-space:pre-wrap;border:1px solid #DDE3EB;border-radius:6px;padding:16px;color:#0E1B2E;font-size:14px">{html.escape(post_text)}</div>
<p style="font-size:13px;margin:12px 0 4px"><b>Sources</b></p><ul style="font-size:13px;margin-top:0">{src_html}</ul>
<h2 style="font-family:Georgia,serif;color:#0E1B2E;font-size:20px;margin:28px 0 8px">Your morning briefing</h2>
<div style="font-size:14px">{markdown.markdown(briefing_md)}</div>
<p style="font-size:12px;color:#66748A;border-top:1px solid #DDE3EB;padding-top:10px;margin-top:28px">Sent by your STS LinkedIn agent.</p>
</div>"""

    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, f"STS LinkedIn Agent <{sender}>", to
    msg.set_content(plain)
    msg.add_alternative(rich, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60) as s:
        s.login(sender, password)
        s.send_message(msg)
    print(f"Emailed {to}.")
    return True
