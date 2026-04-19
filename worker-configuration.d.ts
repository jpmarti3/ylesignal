interface AiBinding {}

type DailyDigest = {
  generatedAt: string;
  source: string;
  headline: string;
  summary: string;
  watchNext: string;
  stories: Array<{
    title: string;
    link: string;
    whyItMatters: string;
    category: string;
    pubDate?: string;
  }>;
};

type BriefingState = {
  latestDigest: DailyDigest | null;
  digestHistory: DailyDigest[];
  seenLinks: string[];
  lastRunAt: string | null;
  status: "idle" | "running" | "error";
  lastError: string | null;
  delivery: {
    telegramEnabled: boolean;
    lastTelegramAt: string | null;
    lastTelegramError: string | null;
  };
};

interface Env {
  AI: AiBinding;
  ASSETS: Fetcher;
  BriefingAgent: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}
