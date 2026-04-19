import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const APP_AGENT_NAME = "yle-signal";
const YLE_RSS_URL = "https://yle.fi/rss/t/18-219200/en";

type Story = {
  title: string;
  link: string;
  pubDate?: string;
  summary: string;
};

type DigestStory = {
  title: string;
  link: string;
  whyItMatters: string;
  category: string;
  pubDate?: string;
};

type DailyDigest = {
  generatedAt: string;
  source: string;
  headline: string;
  summary: string;
  watchNext: string;
  stories: DigestStory[];
};

export type BriefingState = {
  latestDigest: DailyDigest | null;
  digestHistory: DailyDigest[];
  seenLinks: string[];
  lastRunAt: string | null;
  status: "idle" | "running" | "error";
  lastError: string | null;
};

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function parseRss(xml: string): Story[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return items
    .map((match) => {
      const item = match[1];
      return {
        title: matchTag(item, "title"),
        link: matchTag(item, "link"),
        pubDate: matchTag(item, "pubDate") || undefined,
        summary: matchTag(item, "description") || matchTag(item, "content:encoded") || "",
      } satisfies Story;
    })
    .filter((item) => item.title && item.link);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export class ScoutAgent extends Agent<Env> {
  async fetchLatestStories(limit = 12): Promise<Story[]> {
    const response = await fetch(YLE_RSS_URL, {
      headers: {
        "user-agent": "yle-signal-demo/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`Yle RSS request failed with ${response.status}`);
    }

    const xml = await response.text();
    return parseRss(xml).slice(0, limit);
  }
}

export class BriefingAgent extends Think<Env, BriefingState> {
  initialState: BriefingState = {
    latestDigest: null,
    digestHistory: [],
    seenLinks: [],
    lastRunAt: null,
    status: "idle",
    lastError: null,
  };

  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }

  getSystemPrompt(): string {
    const digest = this.state.latestDigest;
    return [
      "You are Yle Signal, a concise analyst that explains the latest Yle English news.",
      "Only use the stored digest below. If the user asks about something not present, say so clearly.",
      digest
        ? `Latest digest JSON: ${JSON.stringify(digest)}`
        : "No digest exists yet. Suggest running a new digest.",
    ].join("\n\n");
  }

  async onStart(): Promise<void> {
    await this.schedule("0 6 * * 1-5", "buildMorningDigest", {
      trigger: "cron",
    });
  }

  async buildMorningDigest(payload?: { trigger?: string }): Promise<DailyDigest | null> {
    this.setState({
      ...this.state,
      status: "running",
      lastError: null,
    });

    try {
      const scout = await this.subAgent(ScoutAgent, "yle-scout");
      const stories = await scout.fetchLatestStories(10);
      const unseenStories = stories.filter((story) => !this.state.seenLinks.includes(story.link)).slice(0, 5);
      const selected = unseenStories.length > 0 ? unseenStories : stories.slice(0, 5);

      const prompt = [
        "Create a compact JSON briefing from the latest Yle News in English stories.",
        "Return strictly valid JSON with keys: headline, summary, watchNext, stories.",
        "stories must be an array of up to 3 objects with keys: title, link, whyItMatters, category, pubDate.",
        "Keep the tone factual and practical. Keep whyItMatters to one sentence each.",
        "Input stories:",
        JSON.stringify(selected),
      ].join("\n\n");

      const result = await generateText({
        model: this.getModel(),
        prompt,
      });

      const parsed = JSON.parse(result.text) as Omit<DailyDigest, "generatedAt" | "source">;
      const digest: DailyDigest = {
        generatedAt: new Date().toISOString(),
        source: YLE_RSS_URL,
        headline: parsed.headline,
        summary: parsed.summary,
        watchNext: parsed.watchNext,
        stories: parsed.stories,
      };

      const seenLinks = Array.from(new Set([...selected.map((story) => story.link), ...this.state.seenLinks])).slice(0, 200);
      const digestHistory = [digest, ...this.state.digestHistory].slice(0, 14);

      this.setState({
        ...this.state,
        latestDigest: digest,
        digestHistory,
        seenLinks,
        lastRunAt: new Date().toISOString(),
        status: "idle",
        lastError: null,
      });

      console.log("Digest built", { trigger: payload?.trigger ?? "manual", stories: digest.stories.length });
      return digest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({
        ...this.state,
        status: "error",
        lastError: message,
        lastRunAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async generateDigestNow(): Promise<DailyDigest | null> {
    return this.buildMorningDigest({ trigger: "manual" });
  }

  getLatestDigest(): DailyDigest | null {
    return this.state.latestDigest;
  }

  getHistory(): DailyDigest[] {
    return this.state.digestHistory;
  }

  getStatus(): Pick<BriefingState, "status" | "lastRunAt" | "lastError"> {
    return {
      status: this.state.status,
      lastRunAt: this.state.lastRunAt,
      lastError: this.state.lastError,
    };
  }
}

async function getBriefingAgent(env: Env) {
  return getAgentByName(env.BriefingAgent, APP_AGENT_NAME);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/latest" && request.method === "GET") {
      const agent = await getBriefingAgent(env);
      return json({ digest: await agent.getLatestDigest(), status: await agent.getStatus() });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      const agent = await getBriefingAgent(env);
      return json({ history: await agent.getHistory() });
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      const agent = await getBriefingAgent(env);
      const digest = await agent.generateDigestNow();
      return json({ ok: true, digest });
    }

    if (url.pathname === "/api/bootstrap" && request.method === "POST") {
      const agent = await getBriefingAgent(env);
      return json({ ok: true, status: await agent.getStatus() });
    }

    return (await routeAgentRequest(request, env)) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
