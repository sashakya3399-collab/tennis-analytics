-- Tennis Analytics — Supabase schema
-- Run once in the Supabase SQL editor for a fresh project.
--
-- Write path: only the service-role client (Netlify scheduled function,
-- the manual re-run route, the manual-match/live-update server actions)
-- ever inserts/updates these tables. Logged-in users only ever read. RLS
-- reflects that split.

create extension if not exists "pgcrypto";

-- One row per daily collection run (scheduled or manually triggered).
create table if not exists analysis_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  trigger text not null default 'scheduled' check (trigger in ('scheduled', 'manual')),
  matches_found integer not null default 0,
  matches_analyzed integer not null default 0,
  -- doubles / ITF-lower-tier / senior-legends / wheelchair matches dropped
  -- by the top-tier-only filter before analysis — see isTopTierSinglesMatch()
  matches_filtered_out integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists analysis_runs_run_date_idx on analysis_runs (run_date desc);

-- One row per match found on a given day's schedule (before analysis).
create table if not exists daily_schedule (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references analysis_runs (id) on delete cascade,
  match_date date not null,
  tournament text,
  tour_level text,
  round text,
  surface text,
  location text,
  player_a text not null,
  player_b text not null,
  scheduled_time timestamptz,
  weather jsonb,
  source_notes text,
  created_at timestamptz not null default now()
);

create index if not exists daily_schedule_match_date_idx on daily_schedule (match_date desc);
create index if not exists daily_schedule_run_id_idx on daily_schedule (run_id);

-- One row per completed Matrix Engine analysis of a scheduled match.
-- Numeric fields mirror the spec's own "МАТЕМАТИЧЕСКИЙ ИТОГ" compact
-- summary (system-prompt.txt section 075) — confidence/volatility are
-- 0-10 (the spec's own X/10 convention), not a low/medium/high bucket.
create table if not exists match_analyses (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references daily_schedule (id) on delete cascade,
  run_id uuid not null references analysis_runs (id) on delete cascade,
  player_a text not null,
  player_b text not null,
  win_probability_a numeric(5, 4),
  win_probability_b numeric(5, 4),
  predicted_score text,
  third_set_probability numeric(5, 4),
  expected_games_a numeric(4, 1),
  expected_games_b numeric(4, 1),
  expected_total_games numeric(4, 1),
  main_corridor text,
  confidence numeric(3, 1) check (confidence >= 0 and confidence <= 10),
  data_coverage_pct numeric(5, 2),
  volatility numeric(3, 1) check (volatility >= 0 and volatility <= 10),
  total_games_line numeric(4, 1),
  total_over_probability numeric(5, 4),
  total_under_probability numeric(5, 4),
  ranking_a text,
  ranking_b text,
  surface_weather_note text,
  motivation_note text,
  key_factors jsonb,
  full_report text not null,
  model_used text not null,
  used_code_execution boolean not null default false,
  used_search_grounding boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists match_analyses_schedule_id_idx on match_analyses (schedule_id);
create index if not exists match_analyses_run_id_idx on match_analyses (run_id);

-- Ad-hoc "PLAYER_1 / PLAYER_2 / SURFACE" analyses per addendum section 077
-- (dashboard form, not tied to the daily auto-discovered schedule). One row
-- per distinct pair the founder has looked up.
create table if not exists manual_analyses (
  id uuid primary key default gen_random_uuid(),
  player_a text not null,
  player_b text not null,
  tournament text,
  surface text,
  location text,
  -- set when the most recent background run for this pair (pre-match or
  -- live) failed, cleared on the next successful run — the analysis work
  -- runs fire-and-forget in a Netlify Background Function, so this is the
  -- only way a failure becomes visible on the dashboard.
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists manual_analyses_players_idx on manual_analyses (player_a, player_b);

-- One row per PRE-MATCH build or LIVE recompute for a manual_analyses pair,
-- per addendum section 078 — a LIVE entry references the pair's existing
-- PRE-MATCH context instead of rebuilding it from scratch. Same numeric
-- column shape as match_analyses (same "МАТЕМАТИЧЕСКИЙ ИТОГ" summary).
create table if not exists manual_analysis_entries (
  id uuid primary key default gen_random_uuid(),
  manual_analysis_id uuid not null references manual_analyses (id) on delete cascade,
  kind text not null check (kind in ('pre_match', 'live')),
  live_score text, -- null for kind='pre_match'
  win_probability_a numeric(5, 4),
  win_probability_b numeric(5, 4),
  predicted_score text,
  third_set_probability numeric(5, 4),
  expected_games_a numeric(4, 1),
  expected_games_b numeric(4, 1),
  expected_total_games numeric(4, 1),
  main_corridor text,
  confidence numeric(3, 1) check (confidence >= 0 and confidence <= 10),
  data_coverage_pct numeric(5, 2),
  volatility numeric(3, 1) check (volatility >= 0 and volatility <= 10),
  total_games_line numeric(4, 1),
  total_over_probability numeric(5, 4),
  total_under_probability numeric(5, 4),
  ranking_a text,
  ranking_b text,
  surface_weather_note text,
  motivation_note text,
  key_factors jsonb,
  full_report text not null,
  model_used text not null,
  used_code_execution boolean not null default false,
  used_search_grounding boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists manual_analysis_entries_parent_idx on manual_analysis_entries (manual_analysis_id, created_at);

alter table analysis_runs enable row level security;
alter table daily_schedule enable row level security;
alter table match_analyses enable row level security;
alter table manual_analyses enable row level security;
alter table manual_analysis_entries enable row level security;

-- Any authenticated (logged-in) user can read. There is no self-serve
-- signup flow — accounts are created manually in the Supabase dashboard.
create policy "authenticated read analysis_runs" on analysis_runs
  for select using (auth.role() = 'authenticated');

create policy "authenticated read daily_schedule" on daily_schedule
  for select using (auth.role() = 'authenticated');

create policy "authenticated read match_analyses" on match_analyses
  for select using (auth.role() = 'authenticated');

create policy "authenticated read manual_analyses" on manual_analyses
  for select using (auth.role() = 'authenticated');

create policy "authenticated read manual_analysis_entries" on manual_analysis_entries
  for select using (auth.role() = 'authenticated');

-- No insert/update/delete policies for the authenticated role: writes only
-- happen through the service-role client (server actions run server-side
-- and are gated on a logged-in session before calling it), which bypasses
-- RLS entirely.
