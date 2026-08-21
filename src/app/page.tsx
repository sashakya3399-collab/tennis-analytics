import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/actions/auth";
import { ManualAnalysisForm } from "@/app/components/ManualAnalysisForm";
import { deleteManualAnalysis } from "@/app/actions/manual-analysis";
import { LiveUpdateForm } from "@/app/components/LiveUpdateForm";
import { AnalysisSummaryGrid, type AnalysisFields } from "@/app/components/AnalysisSummary";

type ManualEntry = AnalysisFields & {
  id: string;
  kind: "pre_match" | "live";
  live_score: string | null;
  created_at: string;
};

type ManualAnalysisRow = {
  id: string;
  player_a: string;
  player_b: string;
  last_error: string | null;
  status: "processing" | "done" | "error";
  manual_analysis_entries: ManualEntry[];
};

export default async function DashboardPage() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20 text-center">
        <h1 className="text-xl font-semibold">Supabase не настроен</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Заполните NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
          SUPABASE_SERVICE_ROLE_KEY в .env.local и выполните supabase/schema.sql в новом
          проекте Supabase.
        </p>
      </div>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: manualData } = await supabase
    .from("manual_analyses")
    .select("*, manual_analysis_entries(*)")
    .order("created_at", { ascending: false });
  const manualAnalyses = (manualData as ManualAnalysisRow[] | null) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tennis Analytics — тотал 1-го сета</h1>
          <p className="mt-1 text-sm text-neutral-500">{user?.email}</p>
        </div>
        <form action={logout}>
          <button type="submit" className="text-sm text-neutral-500 hover:underline">
            Выйти
          </button>
        </form>
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold">Загрузить скриншот</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Скриншот с линией/диапазоном тотала 1-го сета — игроки, покрытие и линия считываются
          с картинки автоматически, без ручного ввода.
        </p>
        <div className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <ManualAnalysisForm />
        </div>
      </div>

      <div className="mt-8 space-y-4">
        {manualAnalyses.length === 0 && (
          <p className="text-sm text-neutral-500">Пока нет ни одного анализа.</p>
        )}

        {manualAnalyses.map((pair) => {
          const entries = [...(pair.manual_analysis_entries ?? [])].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
          const preMatch = entries.find((e) => e.kind === "pre_match");
          const liveEntries = entries.filter((e) => e.kind === "live");
          const latest = liveEntries[liveEntries.length - 1] ?? preMatch;

          return (
            <div
              key={pair.id}
              className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-medium">
                  {pair.player_a} vs {pair.player_b}
                </h3>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-neutral-500">
                    {latest?.surface ?? ""} {latest?.court_or_tournament ? `· ${latest.court_or_tournament}` : ""}
                  </span>
                  <form action={deleteManualAnalysis}>
                    <input type="hidden" name="manual_analysis_id" value={pair.id} />
                    <button
                      type="submit"
                      className="text-sm text-neutral-500 hover:text-red-600 hover:underline"
                    >
                      Удалить
                    </button>
                  </form>
                </div>
              </div>

              {pair.last_error && (
                <p className="mt-1 text-sm text-red-600">Последний запуск не удался: {pair.last_error}</p>
              )}

              {latest ? (
                <>
                  {latest.kind === "live" && (
                    <p className="mt-1 text-sm text-emerald-600">LIVE · счёт {latest.live_score}</p>
                  )}
                  <AnalysisSummaryGrid a={latest} />
                </>
              ) : (
                <p className="mt-3 text-sm text-neutral-500">
                  {pair.status === "processing"
                    ? "Обрабатывается — обновите страницу через 30-90 секунд."
                    : pair.last_error
                      ? "Повторите загрузку скриншота."
                      : "Анализ ещё не готов — обновите страницу."}
                </p>
              )}

              {liveEntries.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-neutral-500 hover:underline">
                    История LIVE-обновлений ({liveEntries.length})
                  </summary>
                  <div className="mt-2 space-y-3">
                    {liveEntries.map((entry) => (
                      <div key={entry.id} className="rounded-md bg-neutral-50 p-3 dark:bg-neutral-900">
                        <p className="text-xs text-neutral-500">
                          {new Date(entry.created_at).toLocaleString("ru-RU")} · счёт {entry.live_score}
                        </p>
                        <AnalysisSummaryGrid a={entry} />
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {preMatch && <LiveUpdateForm manualAnalysisId={pair.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
