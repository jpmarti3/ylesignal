# Yle Signal

Yle Signal is a lightweight Cloudflare Agents demo that:

- uses a **Project Think-style** top-level agent (`BriefingAgent`)
- uses a **second agent** (`ScoutAgent`) as a sub-agent
- summarizes the latest **Yle Finnish** headlines
- runs on a **cron schedule** every weekday morning
- uses **Workers AI** with **Kimi K2.5**
- can send the latest digest to **Telegram**

## What is in this starter

- `src/server.ts` - the Worker, `BriefingAgent`, and `ScoutAgent`
- `public/index.html` - a minimal UI
- `wrangler.jsonc` - AI binding, assets binding, Durable Object binding, and migration

## Cloudflare dashboard setup

Add these secrets in **Workers & Pages -> your Worker -> Settings -> Variables and Secrets**:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

If these are set, the app will automatically send each newly generated digest to Telegram and also enable the **Lähetä Telegramiin** button in the UI.

## Endpoints

- `GET /api/latest` - latest digest + status
- `GET /api/history` - recent digests
- `POST /api/refresh` - force a new digest now and send it to Telegram if configured
- `POST /api/send-telegram` - send the latest existing digest to Telegram
- `POST /api/bootstrap` - initializes the named agent instance
