import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const APP_AGENT_NAME = "yle-signal";
const YLE_RSS_URL = "https://yle.fi/rss/uutiset/tuoreimmat";

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

function parseModelJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

function fallbackDigest(stories: Story[]): Omit<DailyDigest, "generatedAt" | "source"> {
  const topStories: DigestStory[] = stories.slice(0, 3).map((story) => ({
    title: story.title,
    link: story.link,
    pubDate: story.pubDate,
    category: "uutiset",
    whyItMatters: "Tämä on yksi Ylen uusimmista uutisista ja sitä kannattaa seurata päivän aikana.",
  }));

  return {
    headline: "Yle Signal: tuoreimmat uutiset",
    summary: `Kooste sisältää ${topStories.length} tuoretta Ylen uutista nopeaa katselua varten.`,
    watchNext: "Seuraa, nouseeko jokin näistä aiheista päivän pääuutiseksi tai jatkuvaksi seurannaksi.",
    stories: topStories,
  };
}

function normalizeDigestStory(story: Partial<DigestStory>, fallback: Story): DigestStory {
  return {
    title: story.title || fallback.title,
    link: story.link || fallback.link,
    pubDate: story.pubDate || fallback.pubDate,
    category: story.category || "uutiset",
    whyItMatters:
      story.whyItMatters || "Tämä on yksi Ylen uusimmista uutisista ja sitä kannattaa seurata päivän aikana.",
  };
}

function normalizeDigest(
  parsed: Partial<Omit<DailyDigest, "generatedAt" | "source">>,
  selected: Story[],
): Omit<DailyDigest, "generatedAt" | "source"> {
  const fallback = fallbackDigest(selected);
  const mappedStories = Array.isArray(parsed.stories)
    ? parsed.stories.slice(0, 3).map((story, index) => normalizeDigestStory(story, selected[index] || selected[0]))
    : fallback.stories;

  return {
    headline: parsed.headline || fallback.headline,
    summary: parsed.summary || fallback.summary,
    watchNext: parsed.watchNext || fallback.watchNext,
    stories: mappedStories.length > 0 ? mappedStories : fallback.stories,
  };
}

export class ScoutAgent extends Agent<Env> {
  async fetchLatestStories(limit = 12): Promise<Story[]> {
    const response = await fetch(YLE_RSS_URL, {
      headers: {
        "user-agent": "yle-signal-demo/0.2",
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
      "You are Yle Signal, a concise analyst that explains the latest Yle news in Finnish.",
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
        "Laadi tiivis JSON-muotoinen uutiskatsaus Ylen uusimmista suomenkielisistä uutisista.",
        "Palauta VAIN kelvollinen JSON. Älä käytä markdownia. Älä käytä koodiaitoja. Älä lisää selitystekstiä.",
        "Pakolliset avaimet: headline, summary, watchNext, stories.",
        "stories saa sisältää enintään 3 kohdetta. Jokaisessa kohteessa avaimet: title, link, whyItMatters, category, pubDate.",
        "Kirjoita kaikki arvot suomeksi paitsi linkit.",
        "Pidä tyyli asiallisena ja käytännöllisenä. whyItMatters saa olla vain yksi virke.",
        "Input stories:",
        JSON.stringify(selected),
      ].join("\n\n");

      let parsed: Omit<DailyDigest, "generatedAt" | "source">;

      try {
        const result = await generateText({
          model: this.getModel(),
          prompt,
        });

        parsed = normalizeDigest(parseModelJson(result.text), selected);
      } catch (modelError) {
        console.error("Model generation failed, using fallback digest", modelError);
        parsed = fallbackDigest(selected);
      }

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

      try {
        const digest = await agent.generateDigestNow();
        return json({ ok: true, digest });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: message }, 500);
      }
    }

    if (url.pathname === "/api/bootstrap" && request.method === "POST") {
      const agent = await getBriefingAgent(env);
      return json({ ok: true, status: await agent.getStatus() });
    }

    return (await routeAgentRequest(request, env)) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
