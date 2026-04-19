import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const APP_AGENT_NAME = "yle-signal";
const YLE_RSS_URL = "https://yle.fi/rss/uutiset/tuoreimmat";
const TELEGRAM_API_BASE = "https://api.telegram.org";

const CATEGORY_DEFINITIONS = [
  { key: "politiikka", label: "Politiikka", keywords: ["hallitus", "eduskunta", "presidentti", "ministeri", "puolue", "politiikka", "vaali"] },
  { key: "talous", label: "Talous", keywords: ["talous", "yritys", "pörssi", "markkina", "vero", "inflaatio", "työllisyys", "investointi"] },
  { key: "teknologia", label: "Teknologia", keywords: ["teknologia", "tekoäly", "ai", "ohjelmisto", "data", "kyber", "robotti", "sovellus"] },
  { key: "urheilu", label: "Urheilu", keywords: ["urheilu", "liiga", "ottelu", "maali", "jääkiekko", "jalkapallo", "yleisurheilu", "kisat"] },
  { key: "kulttuuri", label: "Kulttuuri", keywords: ["kulttuuri", "taide", "musiikki", "teatteri", "elokuva", "kirja", "ooppera"] },
  { key: "turvallisuus", label: "Turvallisuus", keywords: ["turvallisuus", "rikos", "poliisi", "onnettomuus", "sota", "puolustus", "rajavartiosto", "pelastus"] },
  { key: "maailma", label: "Maailma", keywords: ["ukraina", "eurooppa", "usa", "kiina", "venäjä", "nato", "ulkomaat", "maailma"] },
  { key: "tiede", label: "Tiede", keywords: ["tiede", "tutkimus", "avaruus", "ilmasto", "lääke", "yliopisto", "tutkija"] },
] as const;

const CATEGORY_KEYS = new Set(CATEGORY_DEFINITIONS.map((category) => category.key));

type CategoryKey = (typeof CATEGORY_DEFINITIONS)[number]["key"] | "yleinen";

type Story = {
  title: string;
  link: string;
  pubDate?: string;
  summary: string;
  category?: CategoryKey;
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

type DeliveryState = {
  telegramEnabled: boolean;
  lastTelegramAt: string | null;
  lastTelegramError: string | null;
};

type ParsedTelegramIntent = {
  action: "help" | "categories" | "category_news" | "search" | "refine_search";
  count?: number;
  categories?: string[];
  searchTerm?: string;
  refineText?: string;
};

type TelegramAgentState = {
  lastSearchTerm: string | null;
  lastResultSummary: string | null;
  lastCategories: string[];
  lastCount: number;
};

export type BriefingState = {
  latestDigest: DailyDigest | null;
  digestHistory: DailyDigest[];
  seenLinks: string[];
  lastRunAt: string | null;
  status: "idle" | "running" | "error";
  lastError: string | null;
  delivery: DeliveryState;
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
  const match = block.match(new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function matchTags(block: string, tag: string): string[] {
  return [...block.matchAll(new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "gi"))]
    .map((match) => decodeXml(match[1]))
    .filter(Boolean);
}

function normalizeFinnishText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9åäö\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCategory(text: string, category: (typeof CATEGORY_DEFINITIONS)[number]): number {
  const normalized = normalizeFinnishText(text);
  let score = 0;
  for (const keyword of category.keywords) {
    const key = normalizeFinnishText(keyword);
    if (!key) continue;
    if (normalized.includes(key)) score += Math.max(1, key.length > 6 ? 2 : 1);
  }
  return score;
}

function classifyCategory(text: string, rssCategories: string[] = []): CategoryKey {
  const combined = `${text} ${rssCategories.join(" ")}`;
  let best: CategoryKey = "yleinen";
  let bestScore = 0;

  for (const category of CATEGORY_DEFINITIONS) {
    let score = scoreCategory(combined, category);
    for (const rssCategory of rssCategories) {
      const normalizedRss = normalizeFinnishText(rssCategory);
      if (
        normalizedRss.includes(normalizeFinnishText(category.key)) ||
        normalizedRss.includes(normalizeFinnishText(category.label))
      ) {
        score += 3;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = category.key;
    }
  }

  return best;
}

function parseRss(xml: string): Story[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return items
    .map((match) => {
      const item = match[1];
      const title = matchTag(item, "title");
      const summary = matchTag(item, "description") || matchTag(item, "content:encoded") || "";
      const rssCategories = matchTags(item, "category");
      return {
        title,
        link: matchTag(item, "link"),
        pubDate: matchTag(item, "pubDate") || undefined,
        summary,
        category: classifyCategory(`${title} ${summary}`, rssCategories),
      } satisfies Story;
    })
    .filter((item) => item.title && item.link);
}

function tokenizeSearchTerm(query: string): string[] {
  const stopwords = new Set([
    "ja", "tai", "on", "ovat", "se", "ne", "the", "a", "an", "of", "for", "to", "with",
    "uusin", "uusinta", "uutinen", "uutisia", "news", "latest", "search", "hae", "etsi", "hakusanalla",
  ]);

  return Array.from(
    new Set(
      normalizeFinnishText(query)
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && !stopwords.has(term)),
    ),
  );
}

function scoreStoryForSearch(story: Story, terms: string[]): number {
  const title = normalizeFinnishText(story.title);
  const summary = normalizeFinnishText(story.summary);
  const combined = `${title} ${summary}`;
  let score = 0;

  for (const term of terms) {
    if (title.includes(term)) score += 5;
    if (summary.includes(term)) score += 2;
    if (combined.includes(term)) score += 1;
  }

  const fullPhrase = normalizeFinnishText(terms.join(" "));
  if (fullPhrase && combined.includes(fullPhrase)) score += 4;

  return score;
}

function rankStoriesBySearch(stories: Story[], query: string): Story[] {
  const terms = tokenizeSearchTerm(query);
  if (terms.length === 0) return [];

  return stories
    .map((story, index) => ({ story, score: scoreStoryForSearch(story, terms), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.story);
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
    category: story.category || "yleinen",
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
    category: story.category || fallback.category || "yleinen",
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

function formatTelegramDigest(digest: DailyDigest): string {
  const storyLines = digest.stories
    .slice(0, 3)
    .map((story, index) => {
      const number = index + 1;
      return [`${number}. ${story.title}`, `Miksi tärkeä: ${story.whyItMatters}`, `${story.link}`].join("\n");
    })
    .join("\n\n");

  return [
    `🗞️ ${digest.headline}`,
    digest.summary,
    storyLines,
    `Seuraa seuraavaksi: ${digest.watchNext}`,
    `Luotu: ${digest.generatedAt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function telegramIsConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

async function telegramApi(env: Env, method: string, payload?: unknown) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Telegram ei ole määritetty. Lisää salaisuus TELEGRAM_BOT_TOKEN.");
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    const description = data?.description || `Telegram ${method} failed with ${response.status}`;
    throw new Error(description);
  }

  return data;
}

async function sendTelegramMessage(env: Env, text: string, chatId?: string | number): Promise<void> {
  const resolvedChatId = chatId ?? env.TELEGRAM_CHAT_ID;
  if (!resolvedChatId) {
    throw new Error("Telegram ei ole määritetty. Lisää salaisuudet TELEGRAM_BOT_TOKEN ja TELEGRAM_CHAT_ID.");
  }

  await telegramApi(env, "sendMessage", {
    chat_id: resolvedChatId,
    text,
    disable_web_page_preview: false,
  });
}

async function setTelegramWebhook(env: Env, baseUrl: string) {
  const payload: Record<string, unknown> = {
    url: `${baseUrl.replace(/\/$/, "")}/telegram/webhook`,
    allowed_updates: ["message"],
  };

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }

  return telegramApi(env, "setWebhook", payload);
}

async function getTelegramWebhookInfo(env: Env) {
  return telegramApi(env, "getWebhookInfo", {});
}

function categoriesHelpText(): string {
  return [
    "Tuetut uutiskategoriat:",
    ...CATEGORY_DEFINITIONS.map((category) => `- ${category.label} (${category.key})`),
    "",
    "Esimerkkejä:",
    '• "Anna 3 uusinta talousuutista"',
    '• "Mitkä kategoriat ovat käytössä?"',
    '• "Hae uutisia hakusanalla datakeskus"',
    '• "Etsi uutisia sanoilla Nato Suomi"',
    '• "Tarkenna hakua lisäämällä Oulu"',
  ].join("\n");
}

function clampCount(value: number | undefined, fallback = 3): number {
  const resolved = value ?? fallback;
  return Math.max(1, Math.min(8, resolved));
}

function normalizeRequestedCategories(values?: string[]): CategoryKey[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const normalized = values
    .map((value) => value.toLowerCase().trim())
    .map((value) => {
      if (CATEGORY_KEYS.has(value as CategoryKey)) return value as CategoryKey;
      const found = CATEGORY_DEFINITIONS.find(
        (category) => category.label.toLowerCase() === value || category.keywords.includes(value),
      );
      return found?.key;
    })
    .filter((value): value is CategoryKey => Boolean(value));
  return Array.from(new Set(normalized));
}

function formatStoryList(stories: Story[], count: number): string {
  const selected = stories.slice(0, count);
  if (selected.length === 0) {
    return "En löytänyt uutisia tällä pyynnöllä.";
  }

  return selected
    .map((story, index) => {
      const category = story.category ? ` [${story.category}]` : "";
      return `${index + 1}. ${story.title}${category}\n${story.link}`;
    })
    .join("\n\n");
}


async function fetchLatestStoriesFromYle(limit = 12): Promise<Story[]> {
  const response = await fetch(YLE_RSS_URL, {
    headers: {
      "user-agent": "yle-signal-demo/0.5",
    },
  });

  if (!response.ok) {
    throw new Error(`Yle RSS request failed with ${response.status}`);
  }

  const xml = await response.text();
  return parseRss(xml).slice(0, limit);
}

async function searchNewsFromYle(query: string, limit = 5): Promise<Story[]> {
  const corpus = await fetchLatestStoriesFromYle(60);
  const ranked = rankStoriesBySearch(corpus, query);
  return ranked.slice(0, limit);
}

function formatSearchResponse(searchTerm: string, stories: Story[], count: number): string {
  return [
    `Käytetty hakutermi: ${searchTerm}`,
    stories.length > 0 ? formatStoryList(stories, count) : "En löytänyt hakutuloksia tällä haulla.",
    'Voit tarkentaa jatkossa esimerkiksi: "tarkenna hakua lisäämällä Helsinki".',
  ].join("\n\n");
}

export class ScoutAgent extends Agent<Env> {
  async fetchLatestStories(limit = 12): Promise<Story[]> {
    return fetchLatestStoriesFromYle(limit);
  }

  async searchNews(query: string, limit = 5): Promise<Story[]> {
    return searchNewsFromYle(query, limit);
  }
}

export class TelegramAgent extends Agent<Env, TelegramAgentState> {
  initialState: TelegramAgentState = {
    lastSearchTerm: null,
    lastResultSummary: null,
    lastCategories: [],
    lastCount: 3,
  };

  private getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }

  private async parseIntent(text: string): Promise<ParsedTelegramIntent> {
    const fallback = this.parseIntentHeuristically(text);
    const prompt = [
      "Tunnista käyttäjän uutispyynnön intentio ja palauta VAIN kelvollinen JSON.",
      "Sallitut action-arvot: help, categories, category_news, search, refine_search.",
      "Palauta myös count (1-8), categories (taulukko avaimista: politiikka, talous, teknologia, urheilu, kulttuuri, turvallisuus, maailma, tiede), searchTerm ja refineText tarvittaessa.",
      "Valitse categories, jos käyttäjä kysyy käytettävissä olevia kategorioita.",
      "Valitse search, jos käyttäjä haluaa hakea uutisia millä tahansa hakusanalla.",
      "Valitse refine_search, jos käyttäjä haluaa tarkentaa edellistä hakua kuten 'tarkenna' tai 'lisää mukaan'.",
      `Käyttäjän viesti: ${text}`,
      `Varafallback JSON: ${JSON.stringify(fallback)}`,
    ].join("\n\n");

    try {
      const result = await generateText({
        model: this.getModel(),
        prompt,
      });
      const parsed = parseModelJson(result.text) as ParsedTelegramIntent;
      return {
        action: parsed.action || fallback.action,
        count: clampCount(parsed.count, fallback.count),
        categories: normalizeRequestedCategories(parsed.categories),
        searchTerm: parsed.searchTerm?.trim(),
        refineText: parsed.refineText?.trim(),
      };
    } catch {
      return fallback;
    }
  }

  private parseIntentHeuristically(text: string): ParsedTelegramIntent {
    const normalized = text.toLowerCase();
    const countMatch = normalized.match(/\b([1-8])\b/);
    const count = clampCount(countMatch ? Number(countMatch[1]) : undefined, this.state.lastCount || 3);

    if (normalized.includes("kategoria") || normalized.includes("category") || normalized.includes("mitä aiheita")) {
      return { action: "categories", count };
    }

    if (normalized.includes("tarkenna") || normalized.includes("refine") || normalized.includes("lisää mukaan")) {
      return {
        action: "refine_search",
        count,
        refineText: text.replace(/^(tarkenna hakua|tarkenna|refine search|refine|lisää mukaan)\s*/i, "").trim(),
      };
    }

    const categories = normalizeRequestedCategories(
      CATEGORY_DEFINITIONS.filter((category) => {
        const aliases = [category.key, category.label.toLowerCase(), ...category.keywords];
        return aliases.some((alias) => normalized.includes(alias.toLowerCase()));
      }).map((category) => category.key),
    );

    if (normalized.includes("etsi") || normalized.includes("hae") || normalized.includes("search")) {
      const searchTerm = text.replace(/^(etsi|hae|search)\s+/i, "").trim();
      return { action: "search", count, categories, searchTerm: searchTerm || text.trim() };
    }

    if (categories.length > 0 || normalized.includes("uusin") || normalized.includes("latest") || normalized.includes("uuti")) {
      return { action: "category_news", count, categories };
    }

    return { action: "help", count };
  }

  async handleIncomingMessage(text: string): Promise<string> {
    const intent = await this.parseIntent(text);

    if (intent.action === "help" || intent.action === "categories") {
      return categoriesHelpText();
    }

    if (intent.action === "category_news") {
      const stories = await fetchLatestStoriesFromYle(20);
      const categories = intent.categories && intent.categories.length > 0 ? intent.categories : this.state.lastCategories;
      const count = clampCount(intent.count, this.state.lastCount || 3);
      const filtered = categories.length > 0
        ? stories.filter((story) => categories.includes(story.category || "yleinen"))
        : stories;

      this.setState({
        ...this.state,
        lastCategories: categories,
        lastCount: count,
        lastResultSummary: `Kategoriauutiset: ${categories.join(", ") || "yleinen"}`,
      });

      const heading = categories.length > 0
        ? `Tässä ${count} uusinta uutista kategorioista: ${categories.join(", ")}`
        : `Tässä ${count} uusinta Ylen uutista`;

      return [heading, formatStoryList(filtered, count), 'Kysy myös: "Mitkä kategoriat ovat käytössä?"'].join("\n\n");
    }

    const count = clampCount(intent.count, this.state.lastCount || 3);
    let searchTerm = intent.searchTerm?.trim();

    if (intent.action === "refine_search") {
      if (!this.state.lastSearchTerm) {
        return 'Minulla ei ole vielä aiempaa hakua tarkennettavaksi. Aloita esimerkiksi: "Hae uutisia hakusanalla datakeskus".';
      }
      searchTerm = `${this.state.lastSearchTerm} ${intent.refineText || ""}`.trim();
    }

    if (!searchTerm) {
      return 'En saanut hakutermiä talteen. Kokeile esimerkiksi: "Hae uutisia hakusanalla merituulivoima".';
    }

    const stories = await searchNewsFromYle(searchTerm, count);
    this.setState({
      ...this.state,
      lastSearchTerm: searchTerm,
      lastCount: count,
      lastResultSummary: `Hakutermi: ${searchTerm}`,
    });
    return formatSearchResponse(searchTerm, stories, count);
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
    delivery: {
      telegramEnabled: false,
      lastTelegramAt: null,
      lastTelegramError: null,
    },
  };

  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }

  getSystemPrompt(): string {
    const digest = this.state.latestDigest;
    return [
      "You are Yle Signal, a concise analyst that explains the latest Yle news in Finnish.",
      "Only use the stored digest below. If the user asks about something not present, say so clearly.",
      digest ? `Latest digest JSON: ${JSON.stringify(digest)}` : "No digest exists yet. Suggest running a new digest.",
    ].join("\n\n");
  }

  async onStart(): Promise<void> {
    await this.schedule("0 6 * * 1-5", "buildMorningDigest", {
      trigger: "cron",
    });
  }

  async buildMorningDigest(payload?: { trigger?: string; sendTelegram?: boolean }): Promise<DailyDigest | null> {
    this.setState({
      ...this.state,
      status: "running",
      lastError: null,
      delivery: {
        ...this.state.delivery,
        telegramEnabled: telegramIsConfigured(this.env),
      },
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

      let delivery: DeliveryState = {
        ...this.state.delivery,
        telegramEnabled: telegramIsConfigured(this.env),
        lastTelegramError: null,
      };

      if (payload?.sendTelegram !== false && telegramIsConfigured(this.env)) {
        try {
          await sendTelegramMessage(this.env, formatTelegramDigest(digest));
          delivery = {
            ...delivery,
            lastTelegramAt: new Date().toISOString(),
            lastTelegramError: null,
          };
        } catch (telegramError) {
          const message = telegramError instanceof Error ? telegramError.message : String(telegramError);
          delivery = {
            ...delivery,
            lastTelegramError: message,
          };
          console.error("Telegram delivery failed", telegramError);
        }
      }

      this.setState({
        ...this.state,
        latestDigest: digest,
        digestHistory,
        seenLinks,
        lastRunAt: new Date().toISOString(),
        status: "idle",
        lastError: null,
        delivery,
      });

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
    return this.buildMorningDigest({ trigger: "manual", sendTelegram: true });
  }

  async sendLatestDigestToTelegram(): Promise<{ ok: true; sentAt: string }> {
    if (!this.state.latestDigest) {
      throw new Error("Katsausta ei ole vielä olemassa. Luo katsaus ensin.");
    }

    await sendTelegramMessage(this.env, formatTelegramDigest(this.state.latestDigest));
    const sentAt = new Date().toISOString();
    this.setState({
      ...this.state,
      delivery: {
        telegramEnabled: telegramIsConfigured(this.env),
        lastTelegramAt: sentAt,
        lastTelegramError: null,
      },
    });
    return { ok: true, sentAt };
  }

  async handleTelegramChat(chatId: string, text: string): Promise<string> {
    const agent = await this.subAgent(TelegramAgent, `telegram-${chatId}`);
    return agent.handleIncomingMessage(text);
  }

  getLatestDigest(): DailyDigest | null {
    return this.state.latestDigest;
  }

  getHistory(): DailyDigest[] {
    return this.state.digestHistory;
  }

  getStatus(): Pick<BriefingState, "status" | "lastRunAt" | "lastError" | "delivery"> {
    return {
      status: this.state.status,
      lastRunAt: this.state.lastRunAt,
      lastError: this.state.lastError,
      delivery: {
        ...this.state.delivery,
        telegramEnabled: telegramIsConfigured(this.env),
      },
    };
  }
}

async function getBriefingAgent(env: Env) {
  return getAgentByName(env.BriefingAgent, APP_AGENT_NAME);
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
      return json({ ok: false, error: "Unauthorized webhook" }, 401);
    }
  }

  const update = (await request.json().catch(() => null)) as
    | {
        message?: {
          chat?: { id?: number | string };
          text?: string;
        };
      }
    | null;

  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text?.trim();
  if (!chatId || !text) {
    return json({ ok: true, ignored: true });
  }

  try {
    const agent = await getBriefingAgent(env);
    const reply = await agent.handleTelegramChat(String(chatId), text);
    await sendTelegramMessage(env, reply, chatId);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(env, `Tapahtui virhe: ${message}`, chatId).catch(() => undefined);
    return json({ ok: false, error: message }, 500);
  }
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

    if (url.pathname === "/api/send-telegram" && request.method === "POST") {
      const agent = await getBriefingAgent(env);

      try {
        const result = await agent.sendLatestDigestToTelegram();
        return json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: message }, 500);
      }
    }

    if (url.pathname === "/api/telegram-webhook" && request.method === "POST") {
      try {
        const result = await setTelegramWebhook(env, url.origin);
        return json({ ok: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: message }, 500);
      }
    }

    if (url.pathname === "/api/telegram-webhook" && request.method === "GET") {
      try {
        if (url.searchParams.get("configure") === "1") {
          const configured = await setTelegramWebhook(env, url.origin);
          return json({ ok: true, configured, expectedWebhookUrl: `${url.origin}/telegram/webhook` });
        }

        const result = await getTelegramWebhookInfo(env);
        return json({ ok: true, result, expectedWebhookUrl: `${url.origin}/telegram/webhook` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: message }, 500);
      }
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/api/bootstrap" && request.method === "POST") {
      const agent = await getBriefingAgent(env);
      return json({ ok: true, status: await agent.getStatus() });
    }

    return (await routeAgentRequest(request, env)) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
