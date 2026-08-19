"use client";

import { useActionState, useRef } from "react";
import { analyzeScreenshotAction, type ManualActionState } from "@/app/actions/manual-analysis";

export function ManualAnalysisForm() {
  const [state, formAction, pending] = useActionState<ManualActionState, FormData>(
    analyzeScreenshotAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(formData) => {
        formAction(formData);
        formRef.current?.reset();
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="flex-1">
        <label className="mb-1 block text-xs text-neutral-500">Скриншот (линии/тотал 1-го сета)</label>
        <input
          name="screenshot"
          type="file"
          accept="image/*"
          required
          className="block w-full text-sm text-neutral-600 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:opacity-90 dark:text-neutral-400 dark:file:bg-white dark:file:text-neutral-900"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Загрузка..." : "Проанализировать"}
      </button>
      {state?.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
      {state?.started && (
        <p className="w-full text-sm text-neutral-500">
          Запущено в фоне — карточка появится ниже через 30-90 секунд (обновите страницу).
        </p>
      )}
    </form>
  );
}
