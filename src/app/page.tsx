import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/actions/auth";
import { RerunButton } from "@/app/components/RerunButton";
import { ManualAnalysisForm } from "@/app/components/ManualAnalysisForm";
import { LiveUpdateForm } from "@/app/components/LiveUpdateForm";
import { AnalysisSummaryGrid, type AnalysisFields } from "@/app/components/AnalysisSummary";

type ScheduleRow = {
  id: string;
  tournament: string | null;
  tour_level: string | null;
  round: string | null;
  surface: string | null;
  location: string | null;
  player_a: string;
  player_b: string;
  scheduled_time: string | null;
  weather: { temp_c?: number; condition?: string } | null;
  match_analyses: AnalysisFields[];
};

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
  tournament: string | null;
  surface: string | null;
  location: string | null;
  last_error: string | null;
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

  const dateISO = new Date().toISOString().slice(0, 10);

  const { data: run } = await supabase
    .from("analysis_runs")
    .select("*")
    .eq("run_date", dateISO)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let schedule: ScheduleRow[] = [];
  if (run) {
    const { data } = await supabase
      .from("daily_schedule")
      .select("*, match_analyses(*)")
      .eq("run_id", run.id)
      .order("scheduled_time", { ascending: true });
    schedule = (data as ScheduleRow[] | null) ?? [];
  }

  const { data: manualData } = await supabase
    .from("manual_analyses")
    .select("*, manual_analysis_entries(*)")
    .order("created_at", { ascending: false });
  const manualAnalyses = (manualData as ManualAnalysisRow[] | null) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tennis Analytics — {dateISO}</h1>
          <p className="mt-1 text-sm text-neutral-500">{user?.email}</p>
        </div>
        <form action={logout}>
          <button type="submit" className="text-sm text-neutral-500 hover:underline">
            Выйти
          </button>
        </form>
      </div>

      <div className="mt-6 flex items-center justify-between rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="text-sm">
          {run ? (
            <>
              Статус: <span className="font-medium">{run.status}</span> · Найдено матчей:{" "}
              {run.matches_found} · Проанализировано: {run.matches_analyzed}
              {run.matches_filtered_out > 0 && (
                <> · Отфильтровано (пары/низкий уровень): {run.matches_filtered_out}</>
              )}
              {run.error_message && (
                <p className="mt-1 text-red-600">Ошибки: {run.error_message}</p>
              )}
            </>
          ) : (
            "Анализ на сегодня ещё не запускался."
          )}
        </div>
        <RerunButton />
      </div>

      <div className="mt-8 space-y-4">
        {schedule.length === 0 && (
          <p className="text-sm text-neutral-500">Матчи на сегодня отсутствуют.</p>
        )}

        {schedule.map((match) => {
          const analysis = match.match_analyses?.[0];
          return (
            <div
              key={match.id}
              className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-medium">
                  {match.player_a} vs {match.player_b}
                </h2>
                <span className="text-sm text-neutral-500">
                  {match.tournament} {match.tour_level ? `(${match.tour_level})` : ""}{" "}
                  {match.round ? `· ${match.round}` : ""} {match.surface ? `· ${match.surface}` : ""}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-500">
                {match.location ?? "Локация неизвестна"}
                {match.weather?.condition ? ` · ${match.weather.condition}` : ""}
                {match.weather?.temp_c != null ? `, ${match.weather.temp_c}°C` : ""}
                {match.scheduled_time ? ` · ${new Date(match.scheduled_time).toLocaleString("ru-RU")}` : ""}
              </p>

              {analysis ? (
                <AnalysisSummaryGrid a={analysis} />
              ) : (
                <p className="mt-3 text-sm text-neutral-500">Анализ ещё не готов.</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-12">
        <h2 className="text-lg font-semibold">Ручной анализ (PLAYER_1 / PLAYER_2 / SURFACE)</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Любая пара вне дневного расписания — сразу PRE-MATCH, без уточняющих вопросов.
        </p>
        <div className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <ManualAnalysisForm />
        </div>

        <div className="mt-6 space-y-4">
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
                  <span className="text-sm text-neutral-500">
                    {pair.tournament ?? ""} {pair.surface ? `· ${pair.surface}` : ""}
                  </span>
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
                    {pair.last_error ? "Повторите запуск." : "Анализ ещё не готов — обновите страницу."}
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
    </div>
  );
}
