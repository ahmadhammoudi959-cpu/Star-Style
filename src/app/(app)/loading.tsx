import { getI18n } from "@/i18n";

/** Während eine Seite lädt (z. B. Lager): Logo + laufender Balken in den Logofarben (Wunsch Inhaber 04.11.2026). Seitenleiste bleibt stehen. */
export default async function Loading() {
  const { t } = await getI18n();
  return (
    <div role="status" aria-live="polite" className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
      <div className="relative">
        <div className="ss-glow absolute -inset-8 rounded-full bg-gradient-to-r from-brand-500/25 via-white/0 to-accent-500/25 blur-2xl" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.png" alt="" className="ss-breathe relative h-auto w-40 sm:w-48" />
      </div>
      <div className="h-1.5 w-44 overflow-hidden rounded-full bg-brand-100 sm:w-56">
        <div className="ss-slide h-full w-1/3 rounded-full bg-gradient-to-r from-brand-600 via-brand-400 to-accent-500" />
      </div>
      <span className="text-sm font-semibold text-ink-soft">{t.lists.loading}</span>
    </div>
  );
}
