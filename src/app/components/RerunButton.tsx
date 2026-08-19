"use client";

import { useActionState } from "react";
import { rerunAnalysis, type RerunState } from "@/app/actions/analysis";

export function RerunButton() {
  const [state, formAction, pending] = useActionState<RerunState, FormData>(
    async () => rerunAnalysis(),
    null,
  );

  return (
    <form action={formAction} className="flex items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {pending ? "Запуск..." : "Запустить анализ заново"}
      </button>
      {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      {state?.started && (
        <span className="text-sm text-neutral-500">
          Запущено в фоне — обновите страницу через 1-2 минуты.
        </span>
      )}
    </form>
  );
}
