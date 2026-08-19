import { z } from "zod";
import { generateWithFlash } from "../gemini/client";

const ScheduledMatchSchema = z.object({
  // Nullable: the extraction model occasionally returns null here even
  // though instructed otherwise (confirmed live 2026-08-19 — real matches,
  // just a missing tournament field) — schema must tolerate real model
  // output rather than crash the whole batch on one field.
  tournament: z.string().nullable(),
  tour_level: z.string().nullable().optional(),
  round: z.string().nullable().optional(),
  surface: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  player_a: z.string(),
  player_b: z.string(),
  scheduled_time: z.string().nullable().optional(),
});

export type ScheduledMatch = z.infer<typeof ScheduledMatchSchema>;

const ScheduleResponseSchema = z.array(ScheduledMatchSchema);

/** Pulls the first JSON array found in a text blob, tolerant of prose/fences around it. */
function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in schedule response.");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Top-tier-only gate, applied on top of the prompt-level instruction as a
 * second, code-side check (the model can misclassify). Anything that looks
 * like doubles, ITF World Tennis Tour (M15/M25/W15/W25...), Challengers,
 * seniors/legends circuits (W35/M35/W75/M75...), wheelchair, exhibition,
 * or juniors is dropped rather than silently kept.
 */
const EXCLUDE_KEYWORDS = [
  "itf",
  "challenger",
  "wpci",
  "wheelchair",
  "doubles",
  "legends",
  "senior",
  "exhibition",
  "juniors",
  "qualifying", // pre-qualifying/qualifiers for lower events slip in under odd names; main-draw top-tier only
];

const LOWER_TIER_CODE = /\b[mw]\d{2,3}\b/i; // M15, M25, W35, M75, W75, W125, etc.

const TOP_TIER_LEVEL_HINTS = [
  "grand slam",
  "masters 1000",
  "atp 1000",
  "wta 1000",
  "atp 500",
  "wta 500",
  "atp 250",
  "wta 250",
  "atp finals",
  "wta finals",
  "australian open",
  "roland garros",
  "french open",
  "wimbledon",
  "us open",
];

export function isTopTierSinglesMatch(match: ScheduledMatch): boolean {
  // No tournament name at all means the top-tier level can't be verified —
  // exclude rather than silently assume it's fine.
  if (!match.tournament) return false;

  const haystack = `${match.tournament} ${match.round ?? ""} ${match.tour_level ?? ""}`.toLowerCase();

  if (EXCLUDE_KEYWORDS.some((kw) => haystack.includes(kw))) return false;
  if (LOWER_TIER_CODE.test(match.tournament)) return false;
  if (match.player_a.includes("/") || match.player_b.includes("/")) return false; // doubles pair

  const hasTopTierHint =
    TOP_TIER_LEVEL_HINTS.some((hint) => haystack.includes(hint)) ||
    (match.tour_level ?? "").toLowerCase().includes("atp") ||
    (match.tour_level ?? "").toLowerCase().includes("wta");

  return hasTopTierHint;
}

const SCHEDULE_SYSTEM_PROMPT =
  "You extract structured tennis schedule data using your real, live Google Search tool. " +
  "Never invent matches you did not actually find via search.";

/**
 * Finds today's real ATP/WTA schedule, restricted to top-tier tour-level
 * singles only — no doubles, no ITF World Tennis Tour (M15/M25/W15/W25...),
 * no Challengers, no seniors/legends/wheelchair/exhibition circuits.
 *
 * Single agentic Gemini call with the googleSearch tool enabled — the model
 * decides itself how many queries to run and can re-search with different
 * phrasing if the first pass doesn't clearly answer the question. This
 * replaces the earlier two-step Tavily-pre-fetch-then-extract design (see
 * git history around 2026-08-19), which was only needed because Groq's own
 * search tool was broken.
 *
 * PROMPT SHAPE MATTERS (confirmed live 2026-08-19, real A/B test against
 * the API): asking for "ONLY a raw JSON array, no prose" made the model
 * skip calling googleSearch entirely and answer from training-data recall
 * instead — verified via groundingMetadata being completely absent from the
 * response across repeated identical calls. Leading with a short, direct
 * "Search the web right now for: X" imperative, and asking for a trailing
 * fenced json block (not an ONLY-json instruction) instead, reliably
 * produces real groundingMetadata with actual search queries every time.
 * extractJsonArray() below already tolerates a fenced block or a bare
 * array embedded in prose, so this costs nothing on the parsing side.
 */
export async function fetchTodaysSchedule(dateISO: string): Promise<{
  matches: ScheduledMatch[];
  filteredOutCount: number;
}> {
  const prompt = `Search the web right now for: "ATP WTA tennis today's round live scores results
${dateISO}". Favor "today's round / live scores / results" style queries over "order of play /
schedule" style queries — a tournament's order-of-play page usually lives at a FIXED URL that gets
overwritten daily, so a cached copy of it can silently be from an earlier day and look exactly as
current as a genuinely fresh result. If your first search doesn't clearly show which round is
CURRENTLY being played today, search again with different phrasing (e.g. naming a specific
tournament plus "results today") before continuing — do not settle for a single ambiguous source.

Using ONLY what you actually found in those real searches (not prior knowledge — if you did not
genuinely search, say so rather than guessing), identify the top-tier ATP Tour and WTA Tour
SINGLES matches SCHEDULED for ${dateISO}.

FRESHNESS CHECK (mandatory): only include a match pairing if you can confirm, from what you
actually found, that it corresponds to TODAY's (${dateISO}) play — not a past round, not a
past day at the same fixed URL. If you cannot confirm a pairing is genuinely current, leave it
out rather than guessing.

The match-pairings source often does NOT state the tournament name in its own text (e.g. an
order-of-play page may just say "ATP" / "WTA" per match with no tournament name visible). When
that happens, cross-reference a separate search for which tournament is on this week to identify
it — do not leave "tournament" null just because one source alone didn't name it.

ONLY include matches from top-tier tour-level events:
- Grand Slams (Australian Open, Roland Garros/French Open, Wimbledon, US Open)
- ATP Masters 1000 / WTA 1000
- ATP 500 / WTA 500
- ATP 250 / WTA 250
- ATP Finals / WTA Finals

STRICTLY EXCLUDE, even if mentioned in search results:
- Doubles or mixed doubles (singles only)
- ITF World Tennis Tour events (tournament codes like M15, M25, W15, W25, W35, M35, W75, M75, etc.)
- ATP/WTA Challenger Tour
- Wheelchair, seniors/legends, exhibition, or juniors events
- Qualifying rounds of any of the above (main draw only)

Briefly explain what you found and how you confirmed it's current, then append exactly one fenced
block with the extracted matches:
\`\`\`json
[
  {
    "tournament": "string, e.g. Cincinnati Open",
    "tour_level": "string, e.g. ATP Masters 1000 / WTA 500 / Grand Slam",
    "round": "string or null, e.g. Quarterfinal",
    "surface": "string or null, e.g. Hard",
    "location": "string or null, city/country for weather lookup, e.g. Cincinnati, USA",
    "player_a": "string, full player name",
    "player_b": "string, full player name",
    "scheduled_time": "ISO 8601 datetime string or null if not published yet"
  }
]
\`\`\`

If your search genuinely shows no qualifying top-tier ATP/WTA singles matches for this date, use
an empty array: []`;

  const { fullText } = await generateWithFlash(SCHEDULE_SYSTEM_PROMPT, prompt, ["googleSearch"]);
  const parsed = extractJsonArray(fullText);
  const all = ScheduleResponseSchema.parse(parsed);

  const matches = all.filter(isTopTierSinglesMatch);
  return { matches, filteredOutCount: all.length - matches.length };
}
