# Yle Signal

Yle Signal is a lightweight Cloudflare Agents demo that:

- uses a **Project Think-style** top-level agent (`BriefingAgent`)
- uses a **second agent** (`ScoutAgent`) as a sub-agent
- summarizes the latest **Yle News in English** headlines
- runs on a **cron schedule** every weekday morning
- uses **Workers AI** with **Kimi K2.5**

## What is in this starter

- `src/server.ts` - the Worker, `BriefingAgent`, and `ScoutAgent`
- `public/index.html` - a minimal UI
- `wrangler.jsonc` - AI binding, assets binding, Durable Object binding, and migration

## Local development

```bash
npm install
npm run types
npm run dev
```

Open the local URL shown by Wrangler.

## Deployment

```bash
npx wrangler login
npm install
npm run types
npm run deploy
```

After deployment, open the Worker URL once to bootstrap the named `yle-signal` agent instance.

## Endpoints

- `GET /api/latest` - latest digest + status
- `GET /api/history` - recent digests
- `POST /api/refresh` - force a new digest now
- `POST /api/bootstrap` - initializes the named agent instance

## Notes

- The cron is currently set to `0 6 * * 1-5`.
- The app uses the Yle English RSS feed at `https://yle.fi/rss/t/18-219200/en`.
- `ScoutAgent` is a sub-agent, so it does not need its own Durable Object binding.
