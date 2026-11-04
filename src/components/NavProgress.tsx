"use client";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Dünner Balken oben in den Logofarben, sobald eine andere Seite oder ein Filter geladen wird (Wunsch Inhaber 04.11.2026:
 * man soll sehen, dass etwas lädt). Startet beim Klick auf einen Link in der App oder beim Absenden eines Suchformulars,
 * endet, sobald die neue Adresse da ist (spätestens nach 15 s).
 */
export function NavProgress() {
  const path = usePathname();
  const params = useSearchParams();
  const [on, setOn] = useState(false);
  const where = `${path}?${params.toString()}`;

  useEffect(() => { setOn(false); }, [where]);
  useEffect(() => {
    if (!on) return;
    const stop = setTimeout(() => setOn(false), 15000);
    return () => clearTimeout(stop);
  }, [on]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // nur ein Sprung auf der Seite
      setOn(true);
    };
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement | null;
      if (f && (f.getAttribute("method") ?? "get").toLowerCase() === "get") setOn(true); // Suche/Filter (Speichern hat eigene Anzeige)
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => { document.removeEventListener("click", onClick, true); document.removeEventListener("submit", onSubmit, true); };
  }, []);

  return (
    <div aria-hidden className={`pointer-events-none fixed inset-x-0 top-0 z-[70] h-[3px] overflow-hidden bg-brand-100/60 transition-opacity duration-300 print:hidden ${on ? "opacity-100" : "opacity-0"}`}>
      <div className="ss-slide h-full w-1/3 rounded-full bg-gradient-to-r from-brand-600 via-brand-400 to-accent-500" />
    </div>
  );
}
