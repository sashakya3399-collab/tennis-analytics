"use client";

import { useActionState } from "react";
import { addLiveUpdate, type ManualActionState } from "@/app/actions/manual-analysis";

export function LiveUpdateForm({ manualAnalysisId }: { manualAnalysisId: string }) {
  const [state, formAction, pending] = useActionState<ManualActionState, FormData>(
    addLiveUpdate,
    null,
  );

  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="manual_analysis_id" value={manualAnalysisId} />
      <input
        name="live_score"
        placeholder="напр. 6:4, 3:2 40-15"
        required
        className="flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {pending ? "Запуск..." : "Обновить LIVE"}
      </button>
      {state?.error && <span className="w-full text-sm text-red-600">{state.error}</span>}
      {state?.started && (
        <span className="w-full text-sm text-neutral-500">
          Запущено — обновите страницу через 30-60 секунд.
        </span>
      )}
    </form>
  );
}
