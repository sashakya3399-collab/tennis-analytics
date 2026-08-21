-- Tennis Analytics — Supabase schema
-- Run once in the Supabase SQL editor for a fresh project.
-- For an EXISTING project migrating from the pre-2026-08-19 (daily-schedule
-- + win/match-level) shape, run migration_2026-08-19_first_set_total_screenshot.sql
-- instead — this file is the clean target state for a fresh install only.
--
-- Write path: only the service-role client (the Background Function
-- triggered by the screenshot-upload / live-update server actions) ever
-- inserts/updates these tables. Logged-in users only ever read. RLS
-- reflects that split.

create extension if not exists "pgcrypto";

-- Ad-hoc screenshot-driven analyses (addendum section 077, 2026-08-19
-- pivot: screenshot-only input, no daily auto-schedule, no text form).
-- One row per distinct player pair the founder has uploaded a screenshot
-- for. player_a/player_b are extracted BY THE MODEL from the screenshot,
-- not user-typed.
create table if not exists manual_analyses (
  id uuid primary key default gen_random_uuid(),
  player_a text not null,
  player_b text not null,
  -- set when the most recent background run for this pair (pre-match or
  -- live) failed, cleared on the next successful run — the analysis work
  -- runs fire-and-forget in a Netlify Background Function, so this is the
  -- only way a failure becomes visible on the dashboard.
  last_error text,
  -- 'processing' from the moment a screenshot is submitted (before the
  -- Groq chain even starts) through to 'done'/'error'. Lets the dashboard
  -- show something immediately instead of nothing for 30-90s, and lets a
  -- second submission be blocked while one pair's run is still in flight —
  -- two overlapping runs both hammer the same tight per-minute Groq quota
  -- (see migration_2026-08-21_processing_status_guard.sql).
  status text not null default 'done' check (status in ('processing', 'done', 'error')),
  created_at timestamptz not null default now()
);

create index if not exists manual_analyses_players_idx on manual_analyses (player_a, player_b);

-- One row per PRE-MATCH build or LIVE recompute for a manual_analyses pair,
-- per addendum section 078 — a LIVE entry references the pair's existing
-- PRE-MATCH context instead of rebuilding it from scratch.
--
-- Scope (addendum section 081, 2026-08-19): SET 1 total games (over/under)
-- ONLY — no win probability, no predicted match score, no set 2/3. Numeric
-- fields mirror the spec's "МАТЕМАТИЧЕСКИЙ ИТОГ — ТОТАЛ 1-ГО СЕТА" compact
-- summary (system-prompt.txt section 075). confidence/volatility are 0-10
-- (the spec's own X/10 convention).
create table if not exists manual_analysis_entries (
  id uuid primary key default gen_random_uuid(),
  manual_analysis_id uuid not null references manual_analyses (id) on delete cascade,
  kind text not null check (kind in ('pre_match', 'live')),
  live_score text, -- null for kind='pre_match'
  surface text, -- extracted from the screenshot by the model
  court_or_tournament text, -- extracted from the screenshot by the model, if visible
  expected_games_a numeric(4, 1), -- SET 1 only
  expected_games_b numeric(4, 1), -- SET 1 only
  expected_total_games numeric(4, 1), -- SET 1 only
  main_corridor text, -- SET 1 games range
  confidence numeric(3, 1) check (confidence >= 0 and confidence <= 10),
  data_coverage_pct numeric(5, 2),
  volatility numeric(3, 1) check (volatility >= 0 and volatility <= 10),
  total_games_line numeric(4, 1), -- SET 1 total line, clamped to [6.5, 12.5] per addendum 082
  total_over_probability numeric(5, 4),
  total_under_probability numeric(5, 4),
  weather_note text,
  player_state_note text, -- fitness/fatigue/tension/injuries, per addendum 077
  key_factors jsonb,
  full_report text not null,
  model_used text not null,
  used_code_execution boolean not null default false,
  used_search_grounding boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists manual_analysis_entries_parent_idx on manual_analysis_entries (manual_analysis_id, created_at);

alter table manual_analyses enable row level security;
alter table manual_analysis_entries enable row level security;

-- Any authenticated (logged-in) user can read. There is no self-serve
-- signup flow — accounts are created manually in the Supabase dashboard.
create policy "authenticated read manual_analyses" on manual_analyses
  for select using (auth.role() = 'authenticated');

create policy "authenticated read manual_analysis_entries" on manual_analysis_entries
  for select using (auth.role() = 'authenticated');

-- No insert/update/delete policies for the authenticated role: writes only
-- happen through the service-role client (server actions run server-side
-- and are gated on a logged-in session before calling it), which bypasses
-- RLS entirely.
