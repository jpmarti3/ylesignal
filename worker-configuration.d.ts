interface AiBinding {}

type DigestStory = {
  title: string;
  link: string;
  pubDate?: string;
  summary: string;
};

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
};

interface Env {
  AI: AiBinding;
  ASSETS: Fetcher;
  BriefingAgent: DurableObjectNamespace;
}
