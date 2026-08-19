export type AnalysisFields = {
  win_probability_a: number | null;
  win_probability_b: number | null;
  predicted_score: string | null;
  third_set_probability: number | null;
  expected_games_a: number | null;
  expected_games_b: number | null;
  expected_total_games: number | null;
  main_corridor: string | null;
  confidence: number | null;
  total_games_line: number | null;
  total_over_probability: number | null;
  total_under_probability: number | null;
  ranking_a: string | null;
  ranking_b: string | null;
  surface_weather_note: string | null;
  motivation_note: string | null;
  key_factors: Record<string, unknown> | null;
  full_report: string;
  used_code_execution: boolean;
  used_search_grounding: boolean;
};

function pct(v: number | null): string {
  return v != null ? `${Math.round(v * 100)}%` : "—";
}

export function AnalysisSummaryGrid({ a }: { a: AnalysisFields }) {
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-neutral-500">Победа</p>
          <p className="font-medium">
            {pct(a.win_probability_a)} / {pct(a.win_probability_b)}
          </p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">Прогноз счёта</p>
          <p className="font-medium">{a.predicted_score ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">3-й сет</p>
          <p className="font-medium">{pct(a.third_set_probability)}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">
            Тотал {a.total_games_line ?? "—"}
          </p>
          <p className="font-medium">
            {a.total_over_probability != null ? `Б ${Math.round(a.total_over_probability * 100)}%` : "—"} /{" "}
            {a.total_under_probability != null ? `М ${Math.round(a.total_under_probability * 100)}%` : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">Ожид. геймы</p>
          <p className="font-medium">
            {a.expected_games_a ?? "—"} / {a.expected_games_b ?? "—"}
            {a.expected_total_games != null ? ` (${a.expected_total_games})` : ""}
          </p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">Коридор</p>
          <p className="font-medium">{a.main_corridor ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">Рейтинг</p>
          <p className="font-medium">
            {a.ranking_a ?? "—"} / {a.ranking_b ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">Confidence</p>
          <p className="font-medium">{a.confidence != null ? `${a.confidence}/10` : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500">Инструменты</p>
          <p className="font-medium">
            {a.used_code_execution ? "код" : ""}
            {a.used_code_execution && a.used_search_grounding ? " + " : ""}
            {a.used_search_grounding ? "поиск" : ""}
            {!a.used_code_execution && !a.used_search_grounding ? "—" : ""}
          </p>
        </div>
      </div>

      {a.key_factors && (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          {String(a.key_factors.main_model_scenario ?? "")}
        </p>
      )}

      {a.surface_weather_note && (
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="text-neutral-500">Покрытие+погода (10):</span> {a.surface_weather_note}
        </p>
      )}

      {a.motivation_note && (
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="text-neutral-500">Мотивация:</span> {a.motivation_note}
        </p>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-neutral-500 hover:underline">
          Полный отчёт
        </summary>
        <pre className="mt-2 whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs dark:bg-neutral-900">
          {a.full_report}
        </pre>
      </details>
    </>
  );
}
