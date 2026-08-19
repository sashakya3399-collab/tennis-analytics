export type WebSearchResult = {
  answer: string | null;
  results: { title: string; url: string; content: string }[];
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
export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult> {
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
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily search failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r: { title: string; url: string; content: string }) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    })),
  };
}

/** Renders search results as plain text to embed inline in an LLM prompt. */
export function formatSearchResults(label: string, search: WebSearchResult): string {
  const lines = [`SEARCH RESULTS — ${label}:`];
  if (search.answer) lines.push(`Summary: ${search.answer}`);
  search.results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title} (${r.url})\n${r.content}`);
  });
  if (search.results.length === 0 && !search.answer) {
    lines.push("(no results found)");
  }
  return lines.join("\n\n");
}
