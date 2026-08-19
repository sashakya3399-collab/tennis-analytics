"use client";

import { useActionState } from "react";
import { login, type AuthState } from "@/app/actions/auth";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(login, null);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm items-center px-6">
      <div className="w-full rounded-lg border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <h1 className="text-xl font-semibold">Tennis Analytics</h1>
        <p className="mt-1 text-sm text-neutral-500">Доступ только для приглашённых аккаунтов.</p>

        <form action={formAction} className="mt-8 space-y-4">
          <div>
            <label className="mb-1 block text-sm text-neutral-500">Email</label>
            <input
              name="email"
              type="email"
              required
              className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-neutral-500">Пароль</label>
            <input
              name="password"
              type="password"
              required
              className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          </div>

          {state?.error && <p className="text-sm text-red-600">{state.error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending ? "Вход..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
