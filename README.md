# TeleCal

A minimal Telegram bot: create Google Calendar meetings and send Gmail emails with commands.
Includes a tiny website with a **Privacy Policy** (`/privacy`) and **Terms of Service** (`/terms`).

## Commands

```
/connect                                   link Google account
/meet Title | 2026-11-03 14:00 | 30 | a@x.com, b@y.com
/email to@x.com | Subject | Message
/tz Asia/Yangon                            set time zone
/disconnect                                unlink + delete data
/privacy  /terms
```

Every meeting and email shows a **Confirm / Cancel** step before anything is sent.

## Setup

1. **Telegram** — message @BotFather → `/newbot` → copy the token.
2. **Google Cloud** — create a project, enable **Google Calendar API** and **Gmail API**.
   - OAuth consent screen: add your Privacy Policy URL (`https://your-domain.com/privacy`)
     and Terms URL (`https://your-domain.com/terms`).
   - Credentials → OAuth client ID → *Web application*.
     Redirect URI: `https://your-domain.com/oauth/callback`
3. Copy `.env.example` to `.env` and fill it in.
4. Run:

   ```bash
   npm install
   npm start
   ```

5. Optional: in @BotFather use `/setdescription` and include links to `/privacy` and `/terms`.

For local testing, set `BASE_URL=http://localhost:3000` and add
`http://localhost:3000/oauth/callback` as a redirect URI.

## Files

- `index.js` — bot + web server (landing page, legal pages, OAuth callback)
- `public/` — `index.html`, `privacy.html`, `terms.html`, `style.css`
- `data/users.json` — created at runtime (chat ID → Google tokens, time zone)
