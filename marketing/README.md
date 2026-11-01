# LinkedIn head-of-marketing agent

Every morning at **06:00 South African time** this agent emails **stevensjay2@gmail.com** with today's post and a market briefing. Before that it:

1. **Researches the market.** Claude searches the web for the past week's SA solar and battery news:
   NERSA and Eskom decisions, municipal tariffs, wheeling and market reform, IPP rounds, C&I deals,
   component prices, and the global trends that matter here.
2. **Briefs you.** It writes a private morning briefing (top stories, what they mean for STS Tech Group,
   talking points for client meetings, what to watch). It is emailed to you at 06:00, logged as a
   GitHub issue, and saved in `marketing/briefings/`.
3. **Writes and posts to your LinkedIn.** One post a day in your voice, following a weekly content plan
   that mixes what you're doing in the field with market commentary and industry questions.
4. **Checks itself first.** An editor pass confirms every figure has a source, nothing confidential
   leaks, and the post matches your voice. If any check fails, the post is held as a draft for you
   instead of going out.

| Day | Pillar |
|---|---|
| Mon | Market pulse: one big news item and what it means |
| Tue | In the field: what you've been doing, plus a lesson |
| Wed | Insight & education: tariffs, sizing, payback maths |
| Thu | Industry conversation: a trend plus a sharp question to peers |
| Fri | Week in review: your week plus one signal to watch |
| Sat | Leadership & perspective |
| Sun | Big picture: a global trend and its SA impact |

Change any of this in `config.yml`.

---

## Setup (about 20 minutes, once)

### 1. Tell it who you are
Fill in the `[brackets]` in **`profile.md`** (name, role, audience, voice, off-limits topics).
This is the most important step for quality.

### 2. Anthropic API key
Create a key at <https://console.anthropic.com> → API keys.
In GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
- `ANTHROPIC_API_KEY` = your key

### 3. Gmail (sends your 06:00 email)
1. Your Google account needs 2-Step Verification on: <https://myaccount.google.com/security>.
2. Create an app password at <https://myaccount.google.com/apppasswords> (name it "LinkedIn agent").
3. In GitHub add the secret `GMAIL_APP_PASSWORD` = the 16-character password.

The email is sent from and to stevensjay2@gmail.com. To send from another Gmail account, add a
variable `GMAIL_ADDRESS`. To change the recipient or time, edit `email:` in `config.yml`.

### 4. LinkedIn app (lets the agent post as you)
1. Go to <https://www.linkedin.com/developers/apps> → **Create app**. It needs a LinkedIn Company Page;
   use the STS Tech Group page.
2. In **Products**, add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
3. In **Auth**, add the redirect URL `http://localhost:8765/callback`. Copy the Client ID and Client Secret.
4. On your own computer, from this repo:
   ```bash
   pip install requests
   LINKEDIN_CLIENT_ID=xxx LINKEDIN_CLIENT_SECRET=yyy python marketing/agent/get_linkedin_token.py
   ```
   Approve in the browser. It prints three values. Save them in GitHub:
   - Secret `LINKEDIN_ACCESS_TOKEN`
   - Variable (Variables tab) `LINKEDIN_PERSON_URN`
   - Variable `LINKEDIN_TOKEN_EXPIRES`

LinkedIn tokens last **60 days**. The daily issue warns you a week before expiry; re-run step 4
and update the secret. If a token does expire, posts are saved as drafts, so nothing is lost.

### 5. Turn it on
Scheduled workflows only run from the repo's **default branch**, so merge this branch into `main`.
Then do a test run: **Actions → "LinkedIn – daily post" → Run workflow** with **Dry run** ticked.
Manual runs skip the wait, so the email arrives within about 10 minutes. Nothing is published.

**Timing:** the job starts at 05:35, does its research, then waits and sends at 06:00. In auto mode the
LinkedIn post goes live at the same moment. GitHub occasionally starts scheduled jobs late on busy
mornings, so an email can now and then arrive a few minutes after 06:00.

---

## Day to day

- **Feed it what you're doing.** Add a line to `activity.md` whenever something happens. Or, from the
  GitHub mobile app: Actions → "LinkedIn – daily post" → Run workflow → "What did you do today?".
  Mark anything confidential `(private)`.
- **Approve drafts.** When a post is held (review mode, failed editor check, or expired token), open the
  issue, edit the text between the markers if you want, and add the label **`approve-post`**.
  It publishes within a minute and comments with the link.
- **Want to approve every post?** Set `publish_mode: review` in `config.yml`. A sensible way to start is
  review mode for the first week, then switch to `auto` once you're happy with the voice.
- **Read the history.** Every post is logged in `history.jsonl` and every briefing is in `briefings/`.
  The agent reads recent posts so it doesn't repeat itself.

## Cost
Roughly one web-research call and one writing call a day on Claude Opus 5.5, typically well under
US$1 a day depending on how much it searches. GitHub Actions minutes for this are free on most plans.

## Files
| File | What it is |
|---|---|
| `profile.md` | Who you are, your voice, your rules |
| `activity.md` | Your running log of what you're doing |
| `config.yml` | Schedule, publish mode, content pillars, hashtags |
| `briefings/` | Daily market briefings |
| `history.jsonl` | Every post, its sources and its status |
| `agent/` | The code |
| `../.github/workflows/linkedin-*.yml` | The daily job and the approve-to-publish job |
