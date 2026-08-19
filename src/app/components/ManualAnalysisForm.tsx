"use client";

import { useActionState } from "react";
import { createManualAnalysis, type ManualActionState } from "@/app/actions/manual-analysis";

export function ManualAnalysisForm() {
  const [state, formAction, pending] = useActionState<ManualActionState, FormData>(
    createManualAnalysis,
    null,
  );

  return (
    <form action={formAction} className="grid grid-cols-1 gap-3 sm:grid-cols-5 sm:items-end">
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs text-neutral-500">Игрок 1</label>
        <input
          name="player_a"
          required
          className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs text-neutral-500">Игрок 2</label>
        <input
          name="player_b"
          required
          className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs text-neutral-500">Покрытие</label>
        <input
          name="surface"
          placeholder="Hard/Clay/Grass"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs text-neutral-500">Турнир / город (опц.)</label>
        <input
          name="tournament"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
      </div>
      <div className="sm:col-span-1">
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Запуск..." : "Проанализировать"}
        </button>
      </div>
      {state?.error && <p className="text-sm text-red-600 sm:col-span-5">{state.error}</p>}
      {state?.started && (
        <p className="text-sm text-neutral-500 sm:col-span-5">
          Запущено в фоне — карточка появится ниже через 30-60 секунд (обновите страницу).
        </p>
      )}
    </form>
  );
}
