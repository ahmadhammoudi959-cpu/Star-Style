import Link from "next/link";
import { can, requirePerm } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { FilterSelect } from "@/components/FilterSelect";
import { AutoSubmitCheckbox } from "@/components/AutoSubmitCheckbox";
import { formatCents } from "@/lib/money";
import { validTempId } from "@/lib/temp-files";
import { columnLabel, IMPORT_FIELDS, mappingFromParams, type ImportField } from "@/lib/product-import";
import { analyzeImport, ImportError, thumbDataUrl, type ImportPlan } from "@/lib/product-import-db";
import { ImportForm, ImportUpload } from "./ImportClient";

export const dynamic = "force-dynamic";

const PREVIEW_ROWS = 300;

/**
 * Artikel aus Excel/CSV importieren (Wunsch Inhaber 17.11.2026). 1 Datei wählen (oder ?file=… vom Assistenten) →
 * 2 Spalten prüfen (GET-Formular, wirkt sofort) + Vorschau jeder Zeile → 3 importieren (Server prüft alles neu).
 */
export default async function ProductImportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requirePerm("products.edit");
  const { t, intl } = await getI18n();
  const T = t.pimport;
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return Array.isArray(v) ? v[0] : v; };
  const done = one("done")?.split(".").map(Number);
  const fileId = one("file");

  const doneBox = done && done.length === 5 && done.every(Number.isFinite) && (
    <div className="mb-4 flex animate-rise flex-wrap items-center justify-between gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 ring-1 ring-emerald-200" data-import-done>
      <span className="flex items-center gap-2"><Icon name="check" className="h-4 w-4" />
        {T.done.replace("{n}", String(done[0])).replace("{v}", String(done[1])).replace("{p}", String(done[2])).replace("{s}", String(done[3])).replace("{q}", String(done[4]))}</span>
      <Link href="/products" className="btn-ghost px-3 py-1.5 text-sm">{T.toProducts}</Link>
    </div>
  );

  if (!fileId || !validTempId(fileId)) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={T.title} subtitle={T.subtitle} back="/products" />
        {doneBox}
        <ImportUpload t={T} />
      </div>
    );
  }

  const photoIds = (one("photos") ?? "").split(",").filter((x) => validTempId(x));
  const head = Number(one("head"));
  const params = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]))));
  let plan: ImportPlan;
  try {
    plan = await analyzeImport(s.uid, {
      fileId, photoIds, sheet: one("sheet") || null, headerRow: Number.isInteger(head) && head >= 1 ? head - 1 : null,
      mapping: mappingFromParams((k) => params.get(k)), gross: one("gross") === "1",
    });
  } catch (e) {
    const code = e instanceof ImportError ? e.code : "failed";
    if (!(e instanceof ImportError)) console.error("product import preview", e);
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={T.title} subtitle={T.subtitle} back="/products" />
        <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 ring-1 ring-red-200" data-import-error>{(T.errors as Record<string, string>)[code] ?? T.errors.failed}</p>
        <ImportUpload t={T} />
      </div>
    );
  }

  const { rows, status, counts, header } = plan;
  const cols = Math.max(header.length, ...plan.firstRows.map((r) => r.length));
  const colOptions = Array.from({ length: cols }, (_, c) => ({ value: String(c), label: columnLabel(header, c) }));
  const shown = rows.slice(0, PREVIEW_ROWS);
  const thumbs = await Promise.all(shown.map((r) => {
    const data = r.image != null ? plan.sheetData.images[r.image]?.data : null;
    return data ? thumbDataUrl(data) : Promise.resolve(null);
  }));
  const photoName = (i: number | null) => (i == null ? null : plan.photos[i]?.name ?? null);
  const money = (c: number) => (c ? formatCents(c, intl) : "–");
  const issue = (k: string) => (T.issues as Record<string, string>)[k] ?? k;
  const hidden: [string, string][] = [
    ["file", plan.file.id], ["photos", photoIds.join(",")], ["sheet", plan.sheet], ["head", String(plan.headerRow + 1)], ["gross", plan.gross ? "1" : ""],
    ...IMPORT_FIELDS.map((f) => [`m_${f}`, plan.mapping[f] === undefined ? "" : String(plan.mapping[f])] as [string, string]),
  ];
  const rights = [!can(s, "products.prices") && T.noPriceRight, !can(s, "products.cost") && T.noCostRight, !can(s, "stock.receive") && counts.stock > 0 && T.noStockRight].filter(Boolean) as string[];
  const firstRowOf = (g: number) => rows.find((r) => r.group === g && r.first)?.row;

  return (
    <div>
      <PageHeader title={T.title} subtitle={`${plan.file.name} · ${plan.sheet}`} back="/products"
        actions={<Link href="/products/import" className="btn-ghost group"><Icon name="upload" className="h-4 w-4" />{T.change}</Link>} />
      {doneBox}

      {/* Zusammenfassung */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-import-summary>
        {([["products", counts.products, "box", "text-emerald-700"], ["variants", counts.variants, "layers", "text-emerald-700"], ["exists", counts.exists, "check", "text-ink-soft"],
          ["errors", counts.errors, "alert", counts.errors ? "text-red-600" : "text-ink-soft"], ["photos", counts.photos, "camera", "text-brand-700"], ["stock", counts.stock, "truck", "text-brand-700"]] as const).map(([k, n, icon, color]) => (
          <div key={k} className="card animate-rise flex items-center gap-3 p-4" data-import-count={k}>
            <Icon name={icon} className={`h-5 w-5 ${color}`} />
            <div><div className={`num text-xl font-bold ${color}`}>{n}</div><div className="text-xs text-ink-soft">{(T.summary as Record<string, string>)[k]}</div></div>
          </div>
        ))}
      </div>

      {/* Spalten: welche ist was (wirkt sofort) */}
      <form method="get" className="card animate-rise relative z-10 mb-4 space-y-4 p-5" data-import-mapping>
        <input type="hidden" name="file" value={plan.file.id} />
        {photoIds.length > 0 && <input type="hidden" name="photos" value={photoIds.join(",")} />}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-bold">{T.mapping}</h2>
            <p className="text-sm text-ink-soft">{T.mappingHint}</p>
          </div>
          <AutoSubmitCheckbox name="gross" defaultChecked={plan.gross} label={T.gross} />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {plan.sheets.length > 1 && <FilterSelect name="sheet" label={T.sheet} allLabel={T.auto} defaultValue={plan.sheet} icon="sheet" options={plan.sheets.map((n) => ({ value: n, label: n }))} />}
          <FilterSelect name="head" label={T.headerRow} allLabel={T.auto} defaultValue={String(plan.headerRow + 1)} icon="list"
            options={plan.firstRows.map((r, i) => ({ value: String(i + 1), label: `${T.rowN.replace("{n}", String(i + 1))}: ${r.filter(Boolean).slice(0, 3).join(", ").slice(0, 40)}` }))} />
          {IMPORT_FIELDS.map((f: ImportField) => (
            <FilterSelect key={f} name={`m_${f}`} label={(T.f as Record<string, string>)[f]} allLabel={T.none} icon="tag"
              defaultValue={plan.mapping[f] === undefined ? "" : String(plan.mapping[f])} options={colOptions} />
          ))}
        </div>
      </form>

      {/* Vorschau jeder Zeile */}
      <section className="card animate-rise mb-4 overflow-hidden" data-import-preview>
        <h2 className="border-b border-black/5 px-5 py-3 font-bold">{T.preview}</h2>
        <table className="tbl-fit hidden w-full text-sm md:table">
          <thead><tr className="text-start text-xs text-ink-soft">
            <th className="px-3 py-2 text-start">{T.colRow}</th><th className="px-2 py-2 text-start">{T.colPhoto}</th><th className="px-2 py-2 text-start">{T.colName}</th>
            <th className="px-2 py-2 text-start">{T.colCodes}</th><th className="px-2 py-2 text-start">{T.colCategory}</th><th className="px-2 py-2 text-start">{T.colVariant}</th>
            <th className="px-2 py-2 text-start">{T.colPrices}</th><th className="px-2 py-2 text-start">{T.colStock}</th><th className="px-3 py-2 text-start">{T.colStatus}</th>
          </tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.row} className={`border-t border-black/5 align-top ${status[i] === "error" ? "bg-red-50/60" : status[i] === "exists" ? "bg-slate-50 text-ink-soft" : ""}`} data-import-row={status[i]}>
                <td className="num px-3 py-2">{r.row}</td>
                <td className="px-2 py-2">{thumbs[i]
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={thumbs[i]!} alt="" className="h-12 w-12 rounded-lg object-cover ring-1 ring-black/5" />
                  : photoName(r.photo) ? <span className="inline-flex items-center gap-1 text-xs text-brand-700"><Icon name="camera" className="h-3.5 w-3.5" />{photoName(r.photo)}</span> : <span className="text-ink-soft">–</span>}</td>
                <td className="px-2 py-2"><div className="font-semibold" dir="auto">{r.nameDe || "–"}</div>{r.nameNl && <div className="text-xs text-ink-soft" dir="auto">{r.nameNl}</div>}</td>
                <td className="px-2 py-2"><bdi dir="ltr" className="num block">{r.barcode || "–"}</bdi>{r.sku && <bdi dir="ltr" className="block text-xs text-ink-soft">{r.sku}</bdi>}</td>
                <td className="px-2 py-2" dir="auto">{r.category || "–"}</td>
                <td className="px-2 py-2" dir="auto">{[r.size, r.color].filter(Boolean).join(" · ") || "–"}</td>
                <td className="px-2 py-2 text-xs"><div className="num">{T.short.purchase}: {money(r.purchase)}</div><div className="num">{T.short.wholesale}: {money(r.wholesale)}</div><div className="num">{T.short.retail}: {money(r.retail)}</div></td>
                <td className="num px-2 py-2">{r.stock || "–"}{r.expiry && <div className="text-xs text-ink-soft">{T.f.expiry}: {r.expiry.split("-").reverse().join(".")}</div>}</td>
                <td className="px-3 py-2"><RowState T={T} status={status[i]} errors={r.errors.map(issue)} warnings={r.warnings.map(issue)} variantOf={!r.first ? firstRowOf(r.group) : undefined} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-black/5 md:hidden">
          {shown.map((r, i) => (
            <li key={r.row} className={`flex gap-3 px-4 py-3 ${status[i] === "error" ? "bg-red-50/60" : status[i] === "exists" ? "bg-slate-50 text-ink-soft" : ""}`}>
              {thumbs[i]
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={thumbs[i]!} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover ring-1 ring-black/5" />
                : <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs text-ink-soft">{r.row}</span>}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-semibold" dir="auto">{r.nameDe || "–"}{(r.size || r.color) && <span className="ms-1 text-ink-soft">({[r.size, r.color].filter(Boolean).join(" · ")})</span>}</div>
                <div className="flex flex-wrap gap-x-3 text-xs"><bdi dir="ltr" className="num">{r.barcode || r.sku || "–"}</bdi><span className="num">{money(r.retail)}</span>{r.stock > 0 && <span className="num">{T.colStock}: {r.stock}</span>}</div>
                <RowState T={T} status={status[i]} errors={r.errors.map(issue)} warnings={r.warnings.map(issue)} variantOf={!r.first ? firstRowOf(r.group) : undefined} />
              </div>
            </li>
          ))}
        </ul>
        {rows.length > PREVIEW_ROWS && <p className="border-t border-black/5 px-5 py-3 text-sm text-ink-soft">{T.more.replace("{n}", String(rows.length - PREVIEW_ROWS))}</p>}
        {!rows.length && <p className="px-5 py-6 text-sm text-ink-soft">{T.noRows}</p>}
      </section>

      {rights.length > 0 && <div className="mb-4 space-y-1 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">{rights.map((x) => <div key={x}>{x}</div>)}</div>}
      {counts.products === 0 && rows.length > 0 && <p className="mb-4 rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-ink-soft" data-import-nothing>{T.errors.nothing}</p>}
      <ImportForm t={T} hidden={hidden} count={counts.products} canShops={can(s, "products.edit")} />
    </div>
  );
}

function RowState({ T, status, errors, warnings, variantOf }: { T: { st: Record<string, string>; variantOf: string }; status: "new" | "exists" | "error"; errors: string[]; warnings: string[]; variantOf?: number }) {
  return (
    <div className="space-y-0.5 text-xs">
      <span className={`badge ${status === "new" ? "bg-emerald-100 text-emerald-800" : status === "exists" ? "bg-slate-200 text-ink-soft" : "bg-red-100 text-red-700"}`}>{T.st[status]}</span>
      {status === "new" && variantOf && <div className="text-ink-soft">{T.variantOf.replace("{n}", String(variantOf))}</div>}
      {errors.map((e) => <div key={e} className="font-semibold text-red-700">{e}</div>)}
      {warnings.map((w) => <div key={w} className="text-amber-800">{w}</div>)}
    </div>
  );
}
