"use client";
/**
 * Belegdesign (Wunsch Inhaber 12.11.2026): Farben, Kopf/Fuß, Schrift, Logo, Texte und was auf den Belegen steht – mit Vorschau
 * eines Beispielbelegs (Server rendert das echte PDF, erste Seite als Bild). Gespeichert wird nur auf Knopfdruck (Server-Action
 * ohne revalidatePath, eigener „läuft“-Zustand statt useTransition – siehe CLAUDE.md „Hängender Übergang“).
 * Handy: Vorschau als Fenster („Vorschau“ unten), sonst rechts daneben und mitlaufend.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Dict } from "@/i18n/de";
import { Icon, type IconName } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  COL_LIMITS, DEFAULT_DESIGN, LIMITS, PRESETS, PREVIEW_KINDS, TEXT_KINDS, designDiff, isDefaultDesign, parseDesign,
  type DocDesign, type KindTexts, type PreviewKind, type TextKind,
} from "@/lib/doc-design";
import { saveDocDesign } from "./actions";

type Show = DocDesign["show"];
type Common = DocDesign["common"];
type Tab = TextKind | "common";
type Pv = { url: string | null; loading: boolean; error: boolean };
type Msg = "saved" | "saveError" | "resetDone" | null;
type Field = { el: HTMLInputElement | HTMLTextAreaElement; set: (v: string) => void };

const SHOW_ORDER: (keyof Show)[] = ["senderLine", "posColumn", "category", "itemCode", "discountColumn", "photos", "paymentQr", "signature", "website", "bank", "pageNumbers"];
/** Schalter, die nur auf einer Belegart etwas ändern → die Vorschau springt dorthin */
const SHOW_KIND: Partial<Record<keyof Show, PreviewKind>> = { photos: "offer", signature: "offer", paymentQr: "invoice" };
const COL_KEYS = ["colItem", "colQty", "colPrice", "colDiscount", "colTotal", "colPriceGross", "colTotalGross"] as const;
const COLOR_KEYS = ["primary", "accent", "accent2", "text"] as const;
const isTextKind = (k: string): k is TextKind => (TEXT_KINDS as readonly string[]).includes(k);

/** „Platzhalter: {number} Nummer · {date} Datum …“ → Knöpfe zum Einfügen */
function placeholderChips(s: string) {
  const i = s.indexOf(":");
  return (i >= 0 ? s.slice(i + 1) : s).split("·").map((p) => p.trim().match(/^(\{\w+\})\s*(.*)$/)).filter(Boolean)
    .map((m) => ({ token: m![1], label: m![2] || m![1] }));
}

export function DesignStudio({ t, initial }: { t: Dict; initial: DocDesign }) {
  const D = t.design;
  const [design, setDesign] = useState<DocDesign>(initial);
  const clean = useMemo(() => parseDesign(design), [design]);
  const diffJson = useMemo(() => JSON.stringify(designDiff(clean)), [clean]);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(designDiff(initial)));
  const dirty = diffJson !== savedJson;
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [askReset, setAskReset] = useState(false);
  const [kind, setKind] = useState<PreviewKind>("invoice");
  const [tab, setTab] = useState<Tab>("invoice");
  const [big, setBig] = useState(false);
  const [wide, setWide] = useState(false);
  const [pv, setPv] = useState<Pv>({ url: null, loading: false, error: false });
  const pdfForm = useRef<HTMLFormElement>(null);

  const patch = (fn: (d: DocDesign) => DocDesign) => { setDesign(fn); setMsg(null); };
  const setText = (k: TextKind, f: keyof KindTexts, v: string) => patch((d) => ({ ...d, texts: { ...d.texts, [k]: { ...d.texts[k], [f]: v } } }));
  const setCommon = (f: keyof Common, v: string) => patch((d) => ({ ...d, common: { ...d.common, [f]: v } }));

  // ───────── Vorschau: nur sichtbar (breit oder Fenster offen), eine Anfrage nach der anderen, die neueste gewinnt ─────────
  const shown = useRef("");
  const want = useRef<{ key: string; kind: PreviewKind; design: string } | null>(null);
  const busy = useRef(false);
  const urlRef = useRef<string | null>(null);
  const immediate = useRef(true);
  const pump = useRef<() => Promise<void>>(async () => {});
  pump.current = async () => {
    if (busy.current || !want.current) return;
    const job = want.current;
    want.current = null;
    if (job.key === shown.current) return;
    busy.current = true;
    setPv((p) => ({ ...p, loading: true, error: false }));
    try {
      const res = await fetch("/api/pdf/design-preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ kind: job.kind, design: JSON.parse(job.design) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      shown.current = job.key;
      setPv({ url, loading: false, error: false });
    } catch {
      setPv((p) => ({ ...p, loading: false, error: true }));
    } finally {
      busy.current = false;
      if (want.current) void pump.current();
    }
  };
  const key = `${kind}|${diffJson}`;
  const visible = wide || big;
  useEffect(() => {
    if (!visible || shown.current === key) return;
    const delay = immediate.current ? 0 : 450;
    immediate.current = false;
    const id = window.setTimeout(() => { want.current = { key, kind, design: diffJson }; void pump.current(); }, delay);
    return () => window.clearTimeout(id);
  }, [key, kind, diffJson, visible]);
  const retry = () => { want.current = { key, kind, design: diffJson }; void pump.current(); };
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 1024px)");
    const f = () => setWide(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);

  const pickKind = (k: PreviewKind) => { if (k === kind) return; immediate.current = true; setKind(k); if (isTextKind(k)) setTab(k); };
  const pickTab = (k: Tab) => { setTab(k); lastField.current = null; if (k !== "common" && k !== kind) { immediate.current = true; setKind(k); } };
  const openBig = () => { immediate.current = true; setBig(true); };
  const toggleShow = (k: keyof Show, v: boolean) => {
    patch((d) => ({ ...d, show: { ...d.show, [k]: v } }));
    const to = SHOW_KIND[k];
    if (to && to !== kind) { immediate.current = true; setKind(to); if (isTextKind(to)) setTab(to); }
  };
  const openPdf = () => pdfForm.current?.submit();

  // ───────── Speichern (Strg+S geht auch), Warnung beim Verlassen mit Ungespeichertem ─────────
  const latest = useRef(diffJson);
  latest.current = diffJson;
  const savingRef = useRef(false);
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMsg(null);
    const json = latest.current;
    try {
      const r = await saveDocDesign(json);
      if ("ok" in r) { setSavedJson(json); setMsg("saved"); } else setMsg("saveError");
    } catch {
      setMsg("saveError");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveRef.current(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // ───────── Platzhalter einfügen (ins zuletzt benutzte Textfeld, sonst „Text über der Tabelle“) ─────────
  const lastField = useRef<Field | null>(null);
  const introEl = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const insertToken = (token: string) => {
    const f = lastField.current?.el.isConnected ? lastField.current
      : introEl.current && isTextKind(tab) ? { el: introEl.current, set: (v: string) => setText(tab, "intro", v) } : null;
    if (!f) return;
    const el = f.el, s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    const next = el.value.slice(0, s) + token + el.value.slice(e);
    if (el.maxLength > 0 && next.length > el.maxLength) return;
    f.set(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
  };
  const remember = (f: Field) => { lastField.current = f; };

  const isDefault = isDefaultDesign(clean);
  const status = <Status t={t} saving={saving} dirty={dirty} msg={msg} />;
  const saveButton = (cls: string) => (
    <button type="button" onClick={() => void save()} disabled={saving || !dirty} className={`btn-primary group ${cls}`}>
      <Icon name="check" className="h-4 w-4" />{saving ? D.saving : D.save}
    </button>
  );

  return (
    <div className="pb-24 lg:pb-0">
      <PageHeader title={D.title} subtitle={D.subtitle} actions={
        <button type="button" onClick={() => setAskReset(true)} disabled={isDefault} className="btn-ghost group">
          <Icon name="history" className="h-4 w-4" />{D.reset}
        </button>
      } />
      <p className="mb-5 flex items-start gap-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-900 ring-1 ring-brand-100">
        <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />{D.archived}
      </p>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_28rem] 2xl:grid-cols-[minmax(0,1fr)_32rem]">
        <div className="stagger space-y-5">
          {/* Aussehen: Farbvorlagen, Kopf, Fuß, Tabellenkopf, Gesamtbetrag, Logo-Linie */}
          <Section icon="grid" title={D.sections.look}>
            <div className="label">{D.presets}</div>
            <div className="mb-5 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {PRESETS.map((p) => {
                const on = COLOR_KEYS.every((k) => p.colors[k] === clean.colors[k]) && (!p.header || p.header === clean.header) && (!p.footer || p.footer === clean.footer);
                return (
                  <button key={p.key} type="button" aria-pressed={on}
                    onClick={() => patch((d) => ({ ...d, colors: { ...p.colors }, header: p.header ?? d.header, footer: p.footer ?? d.footer }))}
                    className={`group min-w-0 rounded-xl p-1.5 text-xs font-semibold transition duration-200 hover:-translate-y-0.5 ${on ? "bg-brand-50 text-brand-800 ring-2 ring-brand-500" : "bg-white text-ink ring-1 ring-black/10 hover:shadow-card"}`}>
                    <span dir="ltr" className="block overflow-hidden rounded-lg ring-1 ring-black/5">
                      <span className="block h-6" style={{ background: p.colors.primary }} />
                      <span className="flex h-1"><span className="w-[72%]" style={{ background: p.colors.accent }} /><span className="flex-1" style={{ background: p.colors.accent2 }} /></span>
                      <span className="block bg-white px-1.5 py-1.5">
                        <span className="block h-1 w-3/4 rounded-full opacity-40" style={{ background: p.colors.text }} />
                        <span className="mt-1 block h-1 w-1/2 rounded-full" style={{ background: p.colors.accent }} />
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-center">{D.presetNames[p.key as keyof typeof D.presetNames] ?? p.key}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <Choices label={D.header} value={clean.header} onPick={(v) => patch((d) => ({ ...d, header: v }))}
                options={(["band", "light", "minimal"] as const).map((v) => ({ v, label: D.headerStyles[v], doc: { ...clean, header: v } }))} />
              <Choices label={D.footer} value={clean.footer} onPick={(v) => patch((d) => ({ ...d, footer: v }))}
                options={(["band", "light"] as const).map((v) => ({ v, label: D.footerStyles[v], doc: { ...clean, footer: v } }))} />
              <Choices label={D.tableHead} value={clean.tableHead} onPick={(v) => patch((d) => ({ ...d, tableHead: v }))}
                options={(["filled", "line"] as const).map((v) => ({ v, label: D.tableHeads[v], doc: { ...clean, tableHead: v } }))} />
              <Choices label={D.totalBox} value={clean.totalBox} onPick={(v) => patch((d) => ({ ...d, totalBox: v }))}
                options={(["filled", "line"] as const).map((v) => ({ v, label: D.totalBoxes[v], doc: { ...clean, totalBox: v } }))} />
            </div>
            <div className="mt-4"><Switch checked={design.stripe} label={D.stripe} onChange={(v) => patch((d) => ({ ...d, stripe: v }))} /></div>
          </Section>

          {/* Farben */}
          <Section icon="palette" title={D.sections.colors}>
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              {COLOR_KEYS.map((k) => (
                <ColorField key={k} label={D.colors[k]} hint={{ primary: D.colors.primaryHint, accent: D.colors.accentHint, accent2: D.colors.accent2Hint, text: D.colors.textHint }[k]}
                  value={clean.colors[k]} onChange={(v) => patch((d) => ({ ...d, colors: { ...d.colors, [k]: v } }))} />
              ))}
            </div>
          </Section>

          {/* Schrift und Logo */}
          <Section icon="edit" title={D.sections.type}>
            <div className="grid gap-5 md:grid-cols-2">
              <Slider label={D.fontSize} value={clean.fontSize} unit="%" {...LIMITS.fontSize} onChange={(v) => patch((d) => ({ ...d, fontSize: v }))} />
              <Slider label={D.titleSize} value={clean.titleSize} unit="pt" {...LIMITS.titleSize} onChange={(v) => patch((d) => ({ ...d, titleSize: v }))} />
            </div>
            <div className="mt-5">
              <div className="label">{D.logoSize}</div>
              <div role="radiogroup" aria-label={D.logoSize} className="inline-flex rounded-xl bg-slate-100 p-1">
                {(["s", "m", "l"] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={clean.logoSize === v} onClick={() => patch((d) => ({ ...d, logoSize: v }))}
                    className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${clean.logoSize === v ? "bg-white text-brand-700 shadow-card" : "text-ink-soft hover:text-ink"}`}>
                    {D.logoSizes[v]}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          {/* Texte je Belegart + für alle */}
          <Section icon="file" title={D.sections.texts}>
            <div role="tablist" aria-label={D.textsFor} className="swipe-row -mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {[...TEXT_KINDS, "common" as const].map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => pickTab(k)} className={pill(tab === k)}>
                  {k === "common" ? D.allDocs : D.kinds[k]}
                </button>
              ))}
            </div>
            {tab === "common" ? (
              <div key="common">
                <div className="grid grid-cols-2 items-end gap-3">
                  <TextField t={t} className="col-span-2 md:col-span-1" label={D.common.headerNote} value={design.common.headerNote} def={DEFAULT_DESIGN.common.headerNote} max={LIMITS.line} onChange={(v) => setCommon("headerNote", v)} />
                  <TextField t={t} className="col-span-2 md:col-span-1" label={D.common.footerNote} value={design.common.footerNote} def={DEFAULT_DESIGN.common.footerNote} max={LIMITS.line} onChange={(v) => setCommon("footerNote", v)} />
                  <TextField t={t} className="col-span-2 md:col-span-1" label={D.common.thanks} value={design.common.thanks} def={DEFAULT_DESIGN.common.thanks} max={LIMITS.line} onChange={(v) => setCommon("thanks", v)} />
                  <TextField t={t} className="col-span-2 md:col-span-1" label={D.common.notesTitle} value={design.common.notesTitle} def={DEFAULT_DESIGN.common.notesTitle} max={LIMITS.short} required onChange={(v) => setCommon("notesTitle", v)} />
                </div>
                <h3 className="mb-2 mt-5 text-sm font-bold">{D.common.columns}</h3>
                <div className="grid grid-cols-2 items-end gap-3 md:grid-cols-4">
                  {COL_KEYS.map((k) => (
                    <TextField key={k} t={t} label={D.common[k]} value={design.common[k]} def={DEFAULT_DESIGN.common[k]} max={COL_LIMITS[k]} required onChange={(v) => setCommon(k, v)} />
                  ))}
                </div>
              </div>
            ) : (
              <div key={tab}>
                <div className="grid grid-cols-2 items-end gap-3">
                  <TextField t={t} label={D.fields.title} value={design.texts[tab].title} def={DEFAULT_DESIGN.texts[tab].title} max={LIMITS.short} required onChange={(v) => setText(tab, "title", v)} />
                  <TextField t={t} label={D.fields.to} value={design.texts[tab].to} def={DEFAULT_DESIGN.texts[tab].to} max={LIMITS.short} onChange={(v) => setText(tab, "to", v)} />
                  <TextField t={t} className="col-span-2 md:col-span-1" label={D.fields.greeting} value={design.texts[tab].greeting} def={DEFAULT_DESIGN.texts[tab].greeting} max={LIMITS.line} onFocusField={remember} onChange={(v) => setText(tab, "greeting", v)} />
                  <TextField t={t} className="col-span-2 md:col-span-1" label={D.fields.signoff} value={design.texts[tab].signoff} def={DEFAULT_DESIGN.texts[tab].signoff} max={LIMITS.line} onFocusField={remember} onChange={(v) => setText(tab, "signoff", v)} />
                  <TextField t={t} className="col-span-2" multiline rows={3} label={D.fields.intro} value={design.texts[tab].intro} def={DEFAULT_DESIGN.texts[tab].intro} max={LIMITS.para} onFocusField={remember} inputRef={introEl} onChange={(v) => setText(tab, "intro", v)} />
                  <TextField t={t} className="col-span-2" multiline rows={2} label={D.fields.closing} value={design.texts[tab].closing} def={DEFAULT_DESIGN.texts[tab].closing} max={LIMITS.para} onFocusField={remember} onChange={(v) => setText(tab, "closing", v)} />
                  {tab !== "delivery" && <TextField t={t} label={D.fields.total} value={design.texts[tab].total} def={DEFAULT_DESIGN.texts[tab].total} max={LIMITS.short} required onChange={(v) => setText(tab, "total", v)} />}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-ink-soft">{D.placeholders.split(":")[0]}:</span>
                  {placeholderChips(D.placeholders).map((c) => (
                    <button key={c.token} type="button" title={c.token} onMouseDown={(e) => e.preventDefault()} onClick={() => insertToken(c.token)}
                      className="group inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800 ring-1 ring-brand-100 transition hover:bg-brand-100">
                      <Icon name="plus" className="h-3 w-3" />{c.label}
                    </button>
                  ))}
                </div>
                <p className="hint mt-2">{D.emptyHint}</p>
              </div>
            )}
            <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-soft ring-1 ring-black/5">
              <Icon name="receipt" className="mt-0.5 h-4 w-4 shrink-0" />{D.fixedTexts}
            </p>
          </Section>

          {/* Was auf dem Beleg steht + Pflichtangaben */}
          <Section icon="eye" title={D.sections.show}>
            <div className="grid gap-2 md:grid-cols-2">
              {SHOW_ORDER.map((k) => <Switch key={k} checked={design.show[k]} label={D.show[k]} onChange={(v) => toggleShow(k, v)} />)}
            </div>
            <div className="mt-4 rounded-xl bg-slate-50 p-3 ring-1 ring-black/5">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Icon name="lock" className="h-4 w-4 text-ink-soft" />{D.lockedTitle}</p>
              <ul className="flex flex-wrap gap-1.5">
                {D.locked.split("·").map((s) => s.trim()).filter(Boolean).map((s) => (
                  <li key={s} className="badge bg-white font-medium text-ink-soft ring-1 ring-black/10">{s}</li>
                ))}
              </ul>
            </div>
          </Section>
        </div>

        {/* Vorschau rechts (ab Laptop), läuft mit */}
        {/* die Spalte selbst klebt (mit items-start wäre ein sticky-Kind so hoch wie die Spalte und könnte nicht mitlaufen) */}
        <aside className="hidden self-start lg:sticky lg:top-[4.75rem] lg:block">
          <div className="space-y-3">
            {/* Speichern oben, damit es auch auf niedrigen Bildschirmen immer zu sehen ist */}
            <div className="card flex items-center gap-3 p-3">{status}{saveButton("shrink-0")}</div>
            <div className="card p-4">
              <div className="mb-3">
                <h2 className="text-base font-bold">{D.preview}</h2>
                <p className="text-xs text-ink-soft">{D.previewNote}</p>
              </div>
              <PreviewPane t={t} kind={kind} onKind={pickKind} pv={pv} onRetry={retry} onEnlarge={openBig} />
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={openPdf} className="btn-ghost group flex-1 px-3"><Icon name="file" className="h-4 w-4" />{D.openPdf}</button>
                <button type="button" onClick={openBig} className="btn-ghost group px-3"><Icon name="eye" className="h-4 w-4" />{D.enlarge}</button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Handy/Tablet: schwebende Leiste über dem Menü */}
      <div className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 flex items-center gap-2 rounded-2xl bg-white/95 p-2 shadow-lift ring-1 ring-black/5 backdrop-blur print:hidden lg:hidden">
        <Status t={t} saving={saving} dirty={dirty} msg={msg} compact />
        <button type="button" onClick={openBig} className="btn-ghost group shrink-0 px-3"><Icon name="eye" className="h-4 w-4" />{D.preview}</button>
        {saveButton("shrink-0 px-4")}
      </div>

      {big && (
        <Overlay t={t} onClose={() => setBig(false)}>
          <PreviewPane t={t} kind={kind} onKind={pickKind} pv={pv} onRetry={retry} big />
          <div className="mx-auto mt-4 flex max-w-3xl flex-wrap justify-center gap-2">
            <button type="button" onClick={openPdf} className="btn-ghost group"><Icon name="file" className="h-4 w-4" />{D.openPdf}</button>
            {saveButton("")}
          </div>
        </Overlay>
      )}
      {askReset && (
        <AskReset t={t} onNo={() => setAskReset(false)}
          onYes={() => { setAskReset(false); setDesign(DEFAULT_DESIGN); setMsg("resetDone"); }} />
      )}
      {/* „Als PDF öffnen“: normales Formular in ein neues Fenster – kein Popup-Blocker, auch auf dem iPhone */}
      <form ref={pdfForm} method="post" action="/api/pdf/design-preview" target="_blank" className="hidden" aria-hidden>
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="format" value="pdf" />
        <input type="hidden" name="design" value={diffJson} />
      </form>
    </div>
  );
}

const pill = (on: boolean) =>
  `shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${on ? "bg-navy-800 text-white shadow-card" : "bg-white text-ink-soft ring-1 ring-black/10 hover:bg-brand-50 hover:text-ink"}`;

function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="mb-4 flex items-center gap-2.5 text-base font-bold">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-5 w-5" /></span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Status({ t, saving, dirty, msg, compact }: { t: Dict; saving: boolean; dirty: boolean; msg: Msg; compact?: boolean }) {
  const D = t.design;
  const [text, tone] = saving ? [D.saving, "text-brand-700 bg-brand-500"]
    : msg === "saveError" ? [D.saveError, "text-red-700 bg-red-500"]
    : dirty ? [msg === "resetDone" ? D.resetDone : D.unsaved, "text-amber-800 bg-amber-500"]
    : msg === "saved" ? [D.saved, "text-emerald-700 bg-emerald-500"] : ["", ""];
  const [color, dot] = tone.split(" ");
  return (
    <p role="status" aria-live="polite" className={`flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold leading-tight sm:text-sm ${color ?? ""}`}>
      {text && <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${dirty && !saving ? "animate-pulse" : ""}`} />}
      <span className={compact ? "line-clamp-2" : ""}>{text}</span>
    </p>
  );
}

/** Auswahl mit kleiner Skizze des Belegs in dieser Variante (Farben wie eingestellt) */
function Choices<V extends string>({ label, value, options, onPick }: { label: string; value: V; options: { v: V; label: string; doc: DocDesign }[]; onPick: (v: V) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = o.v === value;
          return (
            <button key={o.v} type="button" aria-pressed={on} onClick={() => onPick(o.v)}
              className={`group relative flex w-[6.25rem] flex-col items-center gap-1.5 rounded-xl p-2 text-center text-xs font-semibold leading-tight transition duration-200 hover:-translate-y-0.5 ${on ? "bg-brand-50 text-brand-800 ring-2 ring-brand-500" : "bg-white text-ink ring-1 ring-black/10 hover:shadow-card"}`}>
              {on && <span className="absolute -end-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-white shadow-card"><Icon name="check" className="h-3 w-3" /></span>}
              <MiniDoc d={o.doc} />
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Skizze eines Belegs (immer von links nach rechts wie das deutsche PDF) */
function MiniDoc({ d }: { d: DocDesign }) {
  const c = d.colors, band = d.header === "band", fband = d.footer === "band";
  const line = (a: string, b: string, first: string) => (
    <><span className="h-full" style={{ width: first, background: a }} /><span className="h-full flex-1" style={{ background: b }} /></>
  );
  return (
    <span dir="ltr" aria-hidden className="relative block h-[5.1rem] w-[3.6rem] shrink-0 overflow-hidden rounded-[0.3rem] bg-white shadow-sm ring-1 ring-black/10">
      {band && <span className="absolute inset-x-0 top-0 h-[0.8rem]" style={{ background: c.primary }} />}
      <span className="absolute left-[0.3rem] top-[0.28rem] h-[0.24rem] w-[0.9rem] rounded-[0.06rem]" style={{ background: band ? "#fff" : c.primary }} />
      <span className="absolute right-[0.3rem] top-[0.3rem] h-[0.2rem] w-[0.55rem] rounded-[0.05rem]" style={{ background: band ? "rgba(255,255,255,.7)" : c.accent }} />
      {d.stripe && d.header !== "minimal"
        ? <span className="absolute inset-x-0 top-[0.8rem] flex h-[0.1rem]">{line(c.accent, c.accent2, "72%")}</span>
        : d.header === "light" ? <span className="absolute inset-x-[0.3rem] top-[0.8rem] h-px bg-slate-300" /> : null}
      <span className="absolute left-[0.3rem] top-[1.15rem] h-[0.2rem] w-[1.5rem] rounded-full" style={{ background: c.primary }} />
      {d.stripe && <span className="absolute left-[0.3rem] top-[1.45rem] flex h-[0.07rem] w-[0.55rem]">{line(c.accent, c.accent2, "72%")}</span>}
      <span className="absolute left-[0.3rem] top-[1.68rem] h-[0.08rem] w-[2.4rem] rounded-full opacity-25" style={{ background: c.text }} />
      <span className="absolute left-[0.3rem] top-[1.86rem] h-[0.08rem] w-[1.7rem] rounded-full opacity-25" style={{ background: c.text }} />
      {d.tableHead === "filled"
        ? <span className="absolute inset-x-[0.3rem] top-[2.2rem] h-[0.3rem] rounded-[0.08rem]" style={{ background: c.primary }} />
        : <span className="absolute inset-x-[0.3rem] top-[2.2rem] h-[0.3rem] border-b-[0.06rem]" style={{ borderColor: c.primary }} />}
      {[2.68, 2.93, 3.18].map((y) => <span key={y} className="absolute inset-x-[0.3rem] h-[0.08rem] rounded-full opacity-20" style={{ top: `${y}rem`, background: c.text }} />)}
      <span className="absolute right-[0.3rem] top-[3.45rem] h-[0.36rem] w-[1.4rem] rounded-[0.08rem]"
        style={d.totalBox === "filled" ? { background: c.accent } : { boxShadow: `inset 0 0 0 0.06rem ${c.accent}` }} />
      {fband && <span className="absolute inset-x-0 bottom-0 h-[0.85rem]" style={{ background: c.primary }} />}
      {d.stripe
        ? <span className="absolute inset-x-0 bottom-[0.85rem] flex h-[0.1rem]">{line(c.accent2, c.accent, "28%")}</span>
        : !fband ? <span className="absolute inset-x-[0.3rem] bottom-[0.85rem] h-px bg-slate-300" /> : null}
      {[0.3, 1.4, 2.5].map((x) => (
        <span key={x} className={`absolute bottom-[0.32rem] h-[0.08rem] w-[0.8rem] rounded-full ${fband ? "" : "opacity-30"}`}
          style={{ left: `${x}rem`, background: fband ? "rgba(255,255,255,.75)" : c.text }} />
      ))}
    </span>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="group flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-start text-sm ring-1 ring-black/5 transition hover:bg-brand-50/50">
      <span className="min-w-0">{label}</span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-brand-600" : "bg-slate-300"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "start-[1.375rem]" : "start-0.5"}`} />
      </span>
    </button>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  const id = useId();
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-ink">{label}</label>
        <span className="num badge bg-brand-50 text-brand-700" dir="ltr">{value} {unit}</span>
      </div>
      <div className="flex items-center gap-3">
        <span aria-hidden className="text-xs font-semibold text-ink-soft">A</span>
        <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
          className="h-2 w-full cursor-pointer accent-brand-600" />
        <span aria-hidden className="text-lg font-semibold text-ink-soft">A</span>
      </div>
    </div>
  );
}

/** Farbe: Farbfeld (Farbwähler des Geräts) + Hex-Code zum Eintippen; nur gültige Codes werden übernommen */
function ColorField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const commit = (s: string) => {
    const hex = (s.trim().startsWith("#") ? s.trim() : `#${s.trim()}`).toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(hex)) onChange(hex);
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label">{label}</label>
      <div className="flex items-center gap-2">
        <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl shadow-sm ring-1 ring-black/10 transition hover:scale-105" style={{ background: value }}>
          <input type="color" aria-label={label} value={value.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </span>
        <input id={id} className="input num min-w-0 uppercase" dir="ltr" maxLength={7} spellCheck={false} value={draft ?? value}
          onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }} onBlur={() => setDraft(null)} />
      </div>
      <p className="hint">{hint}</p>
    </div>
  );
}

function TextField({ t, label, value, def, onChange, max, required, multiline, rows = 3, className = "", onFocusField, inputRef }: {
  t: Dict; label: string; value: string; def: string; onChange: (v: string) => void; max: number; required?: boolean; multiline?: boolean; rows?: number;
  className?: string; onFocusField?: (f: Field) => void; inputRef?: { current: HTMLInputElement | HTMLTextAreaElement | null };
}) {
  const id = useId();
  const changed = def !== "" && value !== def;
  const props = {
    id, value, maxLength: max, dir: "auto" as const, placeholder: required ? def : t.design.emptyHint,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    onFocus: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => onFocusField?.({ el: e.currentTarget, set: onChange }),
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => { if (inputRef) inputRef.current = el; },
  };
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-1 flex min-h-7 items-end justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold leading-snug text-ink">{label}</label>
        {changed && (
          <button type="button" onClick={() => onChange(def)} title={t.design.fieldDefault} aria-label={`${t.design.fieldDefault}: ${label}`}
            className="group grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-soft ring-1 ring-black/10 transition hover:bg-brand-50 hover:text-brand-700">
            <Icon name="history" className="h-4 w-4" />
          </button>
        )}
      </div>
      {multiline
        ? <textarea {...props} ref={props.ref as (el: HTMLTextAreaElement | null) => void} rows={rows} className="input resize-y leading-relaxed" />
        : <input {...props} ref={props.ref as (el: HTMLInputElement | null) => void} className="input" />}
    </div>
  );
}

function PreviewPane({ t, kind, onKind, pv, onRetry, onEnlarge, big }: {
  t: Dict; kind: PreviewKind; onKind: (k: PreviewKind) => void; pv: Pv; onRetry: () => void; onEnlarge?: () => void; big?: boolean;
}) {
  const D = t.design;
  return (
    <div className={big ? "mx-auto max-w-3xl" : ""}>
      <div role="tablist" aria-label={D.preview} className={big ? "swipe-row -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" : "flex flex-wrap gap-1.5"}>
        {PREVIEW_KINDS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={k === kind} onClick={() => onKind(k)} className={pill(k === kind)}>{D.kinds[k]}</button>
        ))}
      </div>
      <div className="relative mt-3 rounded-2xl bg-slate-100 p-3 ring-1 ring-black/5">
        {pv.url ? (
          <button type="button" onClick={onEnlarge} disabled={!onEnlarge} aria-label={onEnlarge ? D.enlarge : undefined}
            className="block w-full cursor-zoom-in disabled:cursor-default">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pv.url} alt={`${D.preview}: ${D.kinds[kind]}`}
              className={`mx-auto block h-auto w-auto max-w-full rounded-[0.25rem] bg-white shadow-lift transition-opacity duration-200 ${big ? "" : "max-h-[calc(100vh-25rem)]"} ${pv.loading ? "opacity-60" : ""}`} />
          </button>
        ) : (
          <div className="mx-auto grid aspect-[210/297] w-full max-w-[22rem] place-items-center rounded-[0.25rem] bg-white shadow-card">
            {!pv.error && <span className="flex items-center gap-2 text-xs font-semibold text-ink-soft"><Spinner />{D.previewLoading}</span>}
          </div>
        )}
        {pv.loading && pv.url && (
          <span className="pointer-events-none absolute inset-x-0 top-5 flex justify-center">
            <span className="badge bg-white/95 py-1 text-brand-700 shadow-card ring-1 ring-black/5"><Spinner />{D.previewLoading}</span>
          </span>
        )}
        {pv.error && !pv.loading && (
          <div role="alert" className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-xl bg-amber-50 p-2.5 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">
            <Icon name="alert" className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{D.previewError}</span>
            <button type="button" onClick={onRetry} className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs">{D.retry}</button>
          </div>
        )}
      </div>
    </div>
  );
}

const Spinner = () => <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />;

/** großes Vorschau-Fenster (Handy: einziges Vorschaufenster) */
function Overlay({ t, onClose, children }: { t: Dict; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", esc);
    btn.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-navy-900/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t.design.preview}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className="flex items-center justify-between gap-3 bg-white px-4 py-2.5 shadow-card">
        <h2 className="text-base font-bold">{t.design.preview}</h2>
        <button ref={btn} type="button" onClick={() => closeRef.current()} className="btn-ghost group px-3"><Icon name="x" className="h-4 w-4" />{t.design.close}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6">
        <div className="animate-rise rounded-2xl bg-white p-3 shadow-lift sm:p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function AskReset({ t, onYes, onNo }: { t: Dict; onYes: () => void; onNo: () => void }) {
  const D = t.design;
  const noRef = useRef(onNo);
  noRef.current = onNo;
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") noRef.current(); };
    document.addEventListener("keydown", esc);
    cancel.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="design-reset-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) noRef.current(); }}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-lift animate-rise sm:rounded-2xl sm:pb-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-700"><Icon name="history" className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 id="design-reset-title" className="text-lg font-bold leading-snug">{D.reset}</h2>
            <p className="mt-1 text-sm text-ink-soft">{D.resetConfirm}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onYes} className="btn-primary w-full py-3 text-base">{D.resetYes}</button>
          <button ref={cancel} type="button" onClick={onNo} className="btn-ghost w-full">{t.common.cancel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
