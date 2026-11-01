"""One-time (and every ~60 days) LinkedIn sign-in, run on your own computer.

    pip install requests
    LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=... python marketing/agent/get_linkedin_token.py

It opens LinkedIn in your browser, you approve, and it prints the three values to save as
GitHub secrets/variables. Your LinkedIn app must list http://localhost:8765/callback as an
authorised redirect URL and have the "Sign In with LinkedIn using OpenID Connect" and
"Share on LinkedIn" products added.
"""

from __future__ import annotations

import datetime as dt
import http.server
import os
import secrets
import urllib.parse
import webbrowser

import requests

REDIRECT = "http://localhost:8765/callback"
SCOPES = "openid profile w_member_social"


def main() -> None:
    cid, secret = os.environ["LINKEDIN_CLIENT_ID"], os.environ["LINKEDIN_CLIENT_SECRET"]
    state = secrets.token_urlsafe(16)
    auth_url = "https://www.linkedin.com/oauth/v2/authorization?" + urllib.parse.urlencode(
        {"response_type": "code", "client_id": cid, "redirect_uri": REDIRECT, "state": state, "scope": SCOPES})

    result: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Done. You can close this tab and go back to the terminal.")

        def log_message(self, *args):
            pass

    print("Opening LinkedIn sign-in…\nIf the browser doesn't open, visit:\n" + auth_url)
    webbrowser.open(auth_url)
    http.server.HTTPServer(("localhost", 8765), Handler).handle_request()

    if result.get("state") != state or "code" not in result:
        raise SystemExit(f"Sign-in failed: {result.get('error_description') or result}")

    tok = requests.post("https://www.linkedin.com/oauth/v2/accessToken", timeout=30, data={
        "grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT,
        "client_id": cid, "client_secret": secret}).json()
    if "access_token" not in tok:
        raise SystemExit(f"Token exchange failed: {tok}")

    me = requests.get("https://api.linkedin.com/v2/userinfo", timeout=30,
                      headers={"Authorization": f"Bearer {tok['access_token']}"}).json()
    expires = dt.date.today() + dt.timedelta(seconds=int(tok.get("expires_in", 5184000)))

    print(f"\nSigned in as {me.get('name')}.\n\nSave these in GitHub → Settings → Secrets and variables → Actions:\n")
    print(f"  Secret   LINKEDIN_ACCESS_TOKEN = {tok['access_token']}")
    print(f"  Variable LINKEDIN_PERSON_URN   = urn:li:person:{me['sub']}")
    print(f"  Variable LINKEDIN_TOKEN_EXPIRES = {expires.isoformat()}")
    print("\nThe agent will warn you in its daily issue a week before the token expires.")


if __name__ == "__main__":
    main()
