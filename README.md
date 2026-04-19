# Yle Signal

Yle Signal is a lightweight Cloudflare Agents demo that:

- uses a **Project Think-style** top-level agent (`BriefingAgent`)
- uses a **news scout agent** (`ScoutAgent`) as a sub-agent
- uses a **separate Telegram chat agent** (`TelegramAgent`) per Telegram chat
- summarizes the latest **Yle Finnish** headlines
- runs on a **cron schedule** every weekday morning
- uses **Workers AI** with **Kimi K2.5**
- can send the latest digest to **Telegram**
- can answer Telegram questions in natural language by:
  - category
  - free-form Yle search terms
  - follow-up search refinements

## What is in this starter

- `src/server.ts` - the Worker plus `BriefingAgent`, `ScoutAgent`, and `TelegramAgent`
- `public/index.html` - a minimal UI
- `wrangler.jsonc` - AI binding, assets binding, Durable Object binding, and migration

## Cloudflare dashboard setup

Add these secrets in **Workers & Pages -> your Worker -> Settings -> Variables and Secrets**:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET` (recommended for webhook verification)

## Telegram modes

### Push mode

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, the app will automatically send each newly generated digest to Telegram and also enable the **Lähetä Telegramiin** button in the UI.

### Chat mode

Set the webhook after deploy:

- `POST /api/telegram-webhook` configures Telegram to send bot messages to `/telegram/webhook`
- `GET /api/telegram-webhook` shows Telegram webhook status

Then chat with your bot in Telegram using messages like:

- `Mitkä kategoriat ovat käytössä?`
- `Anna 3 uusinta talousuutista`
- `Hae uutisia hakusanalla datakeskus`
- `Tarkenna hakua lisäämällä Oulu`

## Endpoints

- `GET /api/latest` - latest digest + status
- `GET /api/history` - recent digests
- `POST /api/refresh` - force a new digest now and send it to Telegram if configured
- `POST /api/send-telegram` - send the latest existing digest to Telegram
- `POST /api/bootstrap` - initializes the named agent instance
- `GET /api/telegram-webhook` - show Telegram webhook status
- `POST /api/telegram-webhook` - configure Telegram webhook to the current Worker URL
- `POST /telegram/webhook` - receives Telegram bot updates


Search behavior: free-text search is performed over the latest fetched Yle Finnish news corpus and the bot echoes the exact search term used back to the user for refinement in follow-up chats.
