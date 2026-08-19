export type WebSearchResult = {
  answer: string | null;
  results: { title: string; url: string; content: string; publishedDate: string | null }[];
};

/**
 * Real web search via Tavily (docs.tavily.com) — used in place of an LLM's
 * own built-in search tool. Two independent reasons this app uses a
 * dedicated search step rather than a model's own built-in search:
 * 1. groq/compound's built-in web search tool returns a reproducible 413
 *    "Request Entity Too Large" on essentially any search-triggering
 *    prompt (confirmed live + corroborated on Groq's own community forum).
 * 2. Even where a built-in search tool DOES work (Gemini's googleSearch),
 *    it bills the retrieved page content as input tokens — a single call
 *    was observed pulling in ~440K tokens of page content, costing ~$0.40
 *    in one call (confirmed live 2026-08-19). Tavily returns short curated
 *    snippets instead of full page text, which is both free (1000
 *    requests/month, no card) and far cheaper token-wise if ever handed to
 *    a metered model.
 */
/**
 * topic: "news" biases results toward recently-published, dated content
 * (live scores, news articles) over static reference documents — matters
 * for anything time-sensitive (weather, current player form/injury status).
 */
export async function searchWeb(
  query: string,
  maxResults = 3,
  topic: "general" | "news" = "general",
): Promise<WebSearchResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set. Add it to .env.local.");
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: "basic",
      topic,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily search failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r: Record<string, unknown>) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      content: String(r.content ?? "").slice(0, 400),
      publishedDate: (r.published_date as string | undefined) ?? null,
    })),
  };
}

const MAX_SNIPPET_CHARS = 400;

/** Formats search results as plain-text context to embed in a prompt, with freshness tags. */
export function formatSearchResults(label: string, search: WebSearchResult): string {
  if (search.results.length === 0) return `${label}: no results found.`;

  const lines = search.results.map((r, i) => {
    const dateTag = r.publishedDate ? `[published: ${r.publishedDate}]` : "[no publish date — treat as possibly stale]";
    return `${i + 1}. ${r.title} ${dateTag}\n   ${r.url}\n   ${r.content.slice(0, MAX_SNIPPET_CHARS)}`;
  });

  return `${label}:\n${lines.join("\n")}${search.answer ? `\n\nSummary: ${search.answer}` : ""}`;
}
