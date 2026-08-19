-- Migration: daily-schedule + win/match-level shape -> screenshot-only,
-- SET-1-total-games-only shape (addendum sections 077/081/082, 2026-08-19).
-- Run ONCE in the Supabase SQL editor against the EXISTING project. This is
-- destructive for the tables being dropped — back up first if you want to
-- keep the old daily/match-level analysis history.

-- 1. Drop the daily-schedule pipeline tables entirely (auto-discovery is
--    removed — screenshot upload is now the only input).
drop table if exists match_analyses cascade;
drop table if exists daily_schedule cascade;
drop table if exists analysis_runs cascade;

-- 2. manual_analyses: player_a/player_b are now extracted from the
--    screenshot by the model, not typed into a form — the old
--    tournament/surface/location columns (set at creation time from the
--    form) are redundant with the entry-level surface/court_or_tournament
--    columns added below, so drop them.
alter table manual_analyses
  drop column if exists tournament,
  drop column if exists surface,
  drop column if exists location;

-- 3. manual_analysis_entries: drop match-level/win fields (out of scope
--    per addendum 081), rename the weather column, add the new
--    screenshot-extracted + player-state columns.
alter table manual_analysis_entries
  drop column if exists win_probability_a,
  drop column if exists win_probability_b,
  drop column if exists predicted_score,
  drop column if exists third_set_probability,
  drop column if exists ranking_a,
  drop column if exists ranking_b,
  drop column if exists motivation_note;

alter table manual_analysis_entries
  rename column surface_weather_note to weather_note;

alter table manual_analysis_entries
  add column if not exists surface text,
  add column if not exists court_or_tournament text,
  add column if not exists player_state_note text;

-- Done. Resulting shape matches supabase/schema.sql's manual_analyses /
-- manual_analysis_entries definitions exactly — diff them if unsure.
