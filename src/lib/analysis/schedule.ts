import { z } from "zod";
import { generateGrounded } from "../gemini/client";

const ScheduledMatchSchema = z.object({
  tournament: z.string(),
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

/**
 * Asks Gemini (Google Search grounded) for today's real ATP/WTA schedule,
 * restricted to top-tier tour-level singles only — no doubles, no ITF World
 * Tennis Tour (M15/M25/W15/W25...), no Challengers, no seniors/legends/
 * wheelchair/exhibition circuits.
 * This is a factual retrieval task, not a reasoning task — no code
 * execution needed here, only search grounding.
 */
export async function fetchTodaysSchedule(dateISO: string): Promise<{
  matches: ScheduledMatch[];
  filteredOutCount: number;
}> {
  const prompt = `You have Google Search grounding enabled. Find the real, top-tier ATP Tour and
WTA Tour SINGLES matches SCHEDULED for ${dateISO}.

ONLY include matches from top-tier tour-level events:
- Grand Slams (Australian Open, Roland Garros/French Open, Wimbledon, US Open)
- ATP Masters 1000 / WTA 1000
- ATP 500 / WTA 500
- ATP 250 / WTA 250
- ATP Finals / WTA Finals

STRICTLY EXCLUDE, even if scheduled the same day:
- Doubles or mixed doubles (singles only)
- ITF World Tennis Tour events (tournament codes like M15, M25, W15, W25, W35, M35, W75, M75, etc.)
- ATP/WTA Challenger Tour
- Wheelchair, seniors/legends, exhibition, or juniors events
- Qualifying rounds of any of the above (main draw only)

Use live search results — do not rely on memory, do not invent matches.

Respond with ONLY a raw JSON array (no prose, no markdown fences, no commentary before or
after) where each element has exactly these fields:
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

If there are genuinely no qualifying top-tier ATP/WTA singles matches scheduled for this date,
respond with an empty array: []`;

  const text = await generateGrounded(prompt);
  const parsed = extractJsonArray(text);
  const all = ScheduleResponseSchema.parse(parsed);

  const matches = all.filter(isTopTierSinglesMatch);
  return { matches, filteredOutCount: all.length - matches.length };
}
