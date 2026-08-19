import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. Env-gated: throws only when actually used
 * without credentials, so pages that don't touch the DB still render fine
 * before real Supabase credentials are wired up.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
        "Create a Supabase project, run supabase/schema.sql, and set these in .env.local.",
    );
  }
  return createBrowserClient(url, key);
}
