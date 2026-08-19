export type WebSearchResult = {
  answer: string | null;
  results: { title: string; url: string; content: string; publishedDate: string | null }[];
};

/**
 * Real web search via Tavily (docs.tavily.com) — used in place of an LLM's
 * own built-in search tool. Groq's groq/compound has a built-in web search
 * tool, but it currently returns a reproducible 413 "Request Entity Too
 * Large" on essentially any search-triggering prompt (confirmed live +
 * corroborated on Groq's own community forum, especially bad for
 * non-English output) — so this app does its own search step and feeds
 * real results into the prompt as context instead of relying on Compound
 * to search for itself.
 */
/**
 * topic: "news" biases results toward recently-published, dated content
 * (live scores, news articles) over static reference documents. This
 * matters a lot for anything time-sensitive: the default "general" topic
 * surfaced a stale WTA order-of-play PDF (a URL that gets overwritten
 * daily, so a cached/indexed copy can silently reflect an earlier day) as
 * the top result for a schedule query, and every match extracted from it
 * turned out to be from a day that had already passed (confirmed live,
 * 2026-08-19 — none of the 5 "today's matches" it produced corresponded to
 * the tournament's actual current round). "news" topic reliably returns
 * results with a real publishedDate instead.
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
    results: (data.results ?? []).map(
      (r: { title: string; url: string; content: string; published_date?: string }) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        publishedDate: r.published_date ?? null,
      }),
    ),
  };
}

const MAX_SNIPPET_CHARS = 400;

/**
 * Renders search results as plain text to embed inline in an LLM prompt.
 * Content is truncated per-result — Groq's groq/compound routes prompts
 * through an internal sub-model (meta-llama/llama-4-scout) capped at 30K
 * tokens/minute on the free tier, and the full ~13K-token system prompt
 * already uses most of that budget on its own; untruncated multi-paragraph
 * Tavily snippets pushed single calls to ~20K input tokens (confirmed live,
 * 2026-08-19), leaving almost no headroom before hitting 429s.
 */
export function formatSearchResults(label: string, search: WebSearchResult): string {
  const lines = [`SEARCH RESULTS — ${label}:`];
  if (search.answer) lines.push(`Summary: ${search.answer}`);
  search.results.forEach((r, i) => {
    const snippet =
      r.content.length > MAX_SNIPPET_CHARS
        ? `${r.content.slice(0, MAX_SNIPPET_CHARS)}…`
        : r.content;
    const dateNote = r.publishedDate ? ` [published: ${r.publishedDate}]` : " [no publish date — treat as possibly stale]";
    lines.push(`[${i + 1}] ${r.title}${dateNote} (${r.url})\n${snippet}`);
  });
  if (search.results.length === 0 && !search.answer) {
    lines.push("(no results found)");
  }
  return lines.join("\n\n");
}
