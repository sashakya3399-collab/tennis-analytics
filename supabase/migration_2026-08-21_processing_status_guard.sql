-- Migration: add manual_analyses.status so a placeholder row exists the
-- moment a screenshot is submitted (not only once the background job
-- finishes/fails), and so a second submission can be blocked while one is
-- still running. Run ONCE in the Supabase SQL editor against the EXISTING
-- project, BEFORE deploying/using the corresponding code change.
--
-- Root cause this fixes (found 2026-08-21): nothing stopped the founder
-- from submitting a second screenshot while the first was still deep in
-- its Groq retry chain (each chain can legitimately run for minutes). Two
-- overlapping background invocations both hammer the SAME 30K-tokens/min
-- budget on groq/compound's internal routing model
-- (meta-llama/llama-4-scout-17b-16e-instruct) — confirmed live via 3
-- consecutive real attempts across 6 minutes, all failing with "Used"
-- pinned near the 30K ceiling the whole time, which a simple per-minute
-- window should not do if only one caller were active.

alter table manual_analyses
  add column if not exists status text not null default 'done'
    check (status in ('processing', 'done', 'error'));

-- Existing rows are backfilled 'done' by the default above (fine — they're
-- all already-finished, real historical rows; the ones that failed already
-- carry last_error regardless of status).
