import { getI18n } from "@/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { locale, t } = await getI18n();
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute -top-40 start-1/2 h-[32.5rem] w-[32.5rem] -translate-x-1/2 rounded-full bg-brand-100 blur-3xl" />
      <div className="absolute end-4 top-4"><LanguageSwitcher current={locale} /></div>
      <div className="relative w-full max-w-md animate-rise">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white shadow-lift">S</div>
          <h1 className="text-2xl font-bold">{t.app.name}</h1>
          <p className="text-sm text-ink-soft">{t.app.tagline}</p>
        </div>
        {children}
      </div>
    </main>
  );
}
