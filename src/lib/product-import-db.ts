import "server-only";
/**
 * Artikel-Import aus Excel/CSV – Datenbank-Teil (Wunsch Inhaber 17.11.2026). Liest die abgelegte Datei der Person,
 * prüft gegen das System (Barcode/Art.-Nr. schon vergeben → überspringen, Lieferant nach Namen) und legt die neuen Artikel
 * in EINER Transaktion an: Kategorie ins Verzeichnis, Größen/Farben mit Barcode, Preise, Fotos, Anfangsbestand als
 * normaler Wareneingang (Bestand nie direkt), Protokoll je Artikel + Zusammenfassung.
 */
import sharp from "sharp";
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { loadTempFile } from "./temp-files";
import { readWorkbook, type Sheet } from "./sheet-read";
import { buildImport, guessHeaderRow, guessMapping, IMPORT_MAX_PRODUCTS, type ImportGroup, type ImportRow, type Issue, type Mapping } from "./product-import";
import { canonicalCategory } from "./categories";
import { audit, receiveGoodsTx } from "./stock";
import { storeImageBytes } from "./files";
import { todayIso } from "./dates";

export type RowStatus = "new" | "exists" | "error";
export type ImportPlan = {
  file: { id: string; name: string };
  sheets: string[]; sheet: string; headerRow: number; header: string[]; firstRows: string[][];
  mapping: Mapping; guessed: boolean; gross: boolean;
  rows: ImportRow[]; groups: ImportGroup[]; status: RowStatus[]; supplierIds: Map<string, string>;
  photos: { id: string; name: string }[];
  counts: { products: number; variants: number; exists: number; errors: number; photos: number; stock: number };
  /** für die Vorschau: Bild der Zeile (Index in sheet.images) */
  sheetData: Sheet;
};
export type AnalyzeInput = { fileId: string; photoIds?: string[]; sheet?: string | null; headerRow?: number | null; mapping?: Mapping | null; gross?: boolean };
export class ImportError extends Error { constructor(public code: "fileGone" | "fileType" | "fileXls" | "empty" | "tooMany" | "nothing") { super(code); } }

export async function analyzeImport(uid: string, input: AnalyzeInput): Promise<ImportPlan> {
  const f = await loadTempFile(uid, input.fileId);
  if (!f) throw new ImportError("fileGone");
  if (f.meta.kind !== "sheet") throw new ImportError("fileType");
  let wb;
  try { wb = await readWorkbook(f.buf, f.meta.name); } catch (e) { throw new ImportError((e as { code?: string }).code === "fileXls" ? "fileXls" : (e as { code?: string }).code === "empty" ? "empty" : "fileType"); }
  // Blatt: gewähltes, sonst das mit den meisten gefüllten Zeilen
  const filled = (s: Sheet) => s.rows.filter((r) => r.some((c) => c)).length;
  const sheet = wb.sheets.find((s) => s.name === input.sheet) ?? [...wb.sheets].sort((a, b) => filled(b) - filled(a))[0];
  const headerRow = input.headerRow != null && input.headerRow >= 0 && input.headerRow < Math.min(sheet.rows.length, 15) ? input.headerRow : guessHeaderRow(sheet.rows);
  const header = sheet.rows[headerRow] ?? [];
  const guessed = !input.mapping;
  const mapping = input.mapping ?? guessMapping(header);

  const photos: { id: string; name: string }[] = [];
  for (const id of (input.photoIds ?? []).slice(0, 200)) {
    const p = await loadTempFile(uid, id);
    if (p && p.meta.kind === "image") photos.push({ id, name: p.meta.name });
  }
  const { rows, groups } = buildImport(sheet, headerRow, mapping, { gross: input.gross, photos });

  // gegen das System prüfen: Barcode oder Art.-Nr. schon vergeben → ganzer Artikel „schon da“ (nie doppelt anlegen)
  const barcodes = rows.map((r) => r.barcode).filter(Boolean);
  const skus = groups.map((g) => g.sku).filter(Boolean);
  const takenBarcodes = new Set(barcodes.length ? (await db.select({ b: schema.variants.barcode }).from(schema.variants).where(inArray(schema.variants.barcode, barcodes))).map((x) => x.b!) : []);
  const takenSkus = new Set(skus.length ? (await db.select({ s: schema.products.sku }).from(schema.products).where(inArray(schema.products.sku, skus))).map((x) => x.s) : []);
  const status: RowStatus[] = rows.map((r) => (r.errors.length ? "error" : "new"));
  for (const g of groups) {
    const skuTaken = takenSkus.has(g.sku);
    const anyBarcode = g.rows.some((j) => rows[j].barcode && takenBarcodes.has(rows[j].barcode));
    if (!skuTaken && !anyBarcode) continue;
    for (const j of g.rows) {
      if (status[j] === "error") continue;
      status[j] = "exists";
      const issue: Issue = rows[j].barcode && takenBarcodes.has(rows[j].barcode) ? "barcodeTaken" : "skuTaken";
      if (!rows[j].warnings.includes(issue)) rows[j].warnings.push(issue);
    }
  }
  // Lieferanten nach Namen (nur vorhandene Warenlieferanten werden verbunden)
  const names = [...new Set(rows.map((r) => r.supplier.toLowerCase()).filter(Boolean))];
  const supplierIds = new Map<string, string>();
  if (names.length) {
    const hits = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers)
      .where(sql`lower(${schema.suppliers.name}) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
    for (const h of hits) supplierIds.set(h.name.toLowerCase(), h.id);
  }
  const newGroups = groups.filter((g) => g.rows.some((j) => status[j] === "new"));
  const counts = {
    products: newGroups.length,
    variants: status.filter((s) => s === "new").length,
    exists: status.filter((s) => s === "exists").length,
    errors: status.filter((s) => s === "error").length,
    photos: newGroups.filter((g) => g.rows.some((j) => status[j] === "new" && (rows[j].image != null || rows[j].photo != null))).length,
    stock: rows.reduce((n, r, j) => n + (status[j] === "new" ? r.stock : 0), 0),
  };
  return {
    file: { id: f.meta.id, name: f.meta.name }, sheets: wb.sheets.map((s) => s.name), sheet: sheet.name, headerRow, header,
    firstRows: sheet.rows.slice(0, 15), mapping, guessed, gross: !!input.gross, rows, groups, status, supplierIds, photos, counts, sheetData: sheet,
  };
}

/** Vorschaubild (klein, als data-URL) – nur für die Ansicht */
export async function thumbDataUrl(data: Uint8Array): Promise<string | null> {
  try {
    const b = await sharp(Buffer.from(data)).rotate().resize(96, 96, { fit: "cover" }).webp({ quality: 70 }).toBuffer();
    return `data:image/webp;base64,${b.toString("base64")}`;
  } catch { return null; }
}

async function productImage(uid: string, plan: ImportPlan, row: ImportRow): Promise<string | null> {
  let data: Uint8Array | null = null, name = row.nameDe;
  if (row.image != null) data = plan.sheetData.images[row.image]?.data ?? null;
  else if (row.photo != null) {
    const p = await loadTempFile(uid, plan.photos[row.photo].id);
    if (p) { data = p.buf; name = p.meta.name; }
  }
  if (!data) return null;
  try {
    const webp = await sharp(Buffer.from(data)).rotate().resize(1200, 1200, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).webp({ quality: 82 }).toBuffer();
    return await storeImageBytes(webp, `${name.slice(0, 80)}.webp`);
  } catch { return null; }
}

export type ImportResult = { created: number; variants: number; skipped: number; photos: number; stock: number };

export async function runImport(uid: string, input: AnalyzeInput & { general: boolean; brand: boolean },
  rights: { prices: boolean; cost: boolean; stock: boolean }): Promise<ImportResult> {
  const plan = await analyzeImport(uid, input);
  const groups = plan.groups.map((g) => ({ g, rows: g.rows.filter((j) => plan.status[j] === "new").map((j) => plan.rows[j]) })).filter((x) => x.rows.length);
  if (!groups.length) throw new ImportError("nothing");
  if (groups.length > IMPORT_MAX_PRODUCTS) throw new ImportError("tooMany");

  // Fotos vorher speichern (außerhalb der Transaktion, wie im Artikel-Formular; Dateien sind unveränderlich)
  const productImg = new Map<number, string>(), variantImg = new Map<ImportRow, string>();
  let photos = 0;
  for (const { g, rows } of groups) {
    for (const [n, r] of rows.entries()) {
      if (r.image == null && r.photo == null) continue;
      const id = await productImage(uid, plan, r);
      if (!id) continue;
      if (!productImg.has(g.index)) { productImg.set(g.index, id); photos++; }
      else if (n > 0) variantImg.set(r, id); // eigenes Foto einer Größe/Farbe
    }
  }

  let created = 0, variants = 0, stock = 0;
  await db.transaction(async (tx) => {
    const opening = new Map<string, { variantId: string; qty: number; unitCostCents: number; expiryDate: string | null }[]>();
    for (const { g, rows } of groups) {
      const first = rows[0];
      // gleichzeitig angelegt? dann überspringen statt doppelt
      const skuNow = await tx.select({ id: schema.products.id }).from(schema.products).where(sql`${schema.products.sku} = ${g.sku}`).limit(1);
      if (skuNow.length) continue;
      const supplierId = plan.supplierIds.get(first.supplier.toLowerCase()) ?? null;
      const values = {
        sku: g.sku, nameDe: first.nameDe, nameNl: rows.find((r) => r.nameNl)?.nameNl ?? "", descriptionDe: first.description, descriptionNl: "",
        category: await canonicalCategory(tx, first.category), supplierId, vatRateBp: first.vatBp,
        purchasePriceCents: rights.cost ? first.purchase : 0,
        wholesalePriceCents: rights.prices ? first.wholesale : 0, retailPriceCents: rights.prices ? first.retail : 0,
        tracksExpiry: rows.some((r) => r.expiry), inBrandShop: input.brand, inGeneralShop: input.general,
        imageFileId: productImg.get(g.index) ?? null,
      };
      const [p] = await tx.insert(schema.products).values(values).returning({ id: schema.products.id });
      await audit(tx, { entity: "product", entityId: p.id, action: "create", after: { ...values, source: "excel-import", file: plan.file.name, rows: rows.map((r) => r.row) }, userId: uid });
      created++;
      for (const r of rows) {
        const own = (v: number, base: number) => (rights.prices && v !== base ? v : null); // abweichender Preis = Preis der Größe/Farbe
        const [v] = await tx.insert(schema.variants).values({
          productId: p.id, size: r.size, color: r.color, barcode: r.barcode || null, minStock: r.minStock, weightGrams: r.weightGrams,
          wholesalePriceCents: own(r.wholesale, values.wholesalePriceCents), retailPriceCents: own(r.retail, values.retailPriceCents),
          purchasePriceCents: rights.cost && r.purchase > 0 && r.purchase !== values.purchasePriceCents ? r.purchase : null,
          imageFileId: variantImg.get(r) ?? null,
        }).returning({ id: schema.variants.id });
        variants++;
        if (rights.stock && r.stock > 0) {
          const list = opening.get(supplierId ?? "") ?? [];
          list.push({ variantId: v.id, qty: r.stock, unitCostCents: rights.cost ? r.purchase : 0, expiryDate: r.expiry });
          opening.set(supplierId ?? "", list);
          stock += r.stock;
        }
      }
    }
    // Anfangsbestand als normaler Wareneingang je Lieferant (Charge, MHD, Nummer, Protokoll)
    for (const [supplierId, lines] of opening) {
      await receiveGoodsTx(tx, { supplierId: supplierId || null, date: todayIso(), supplierInvoiceNo: "", note: `Anfangsbestand (Excel-Import: ${plan.file.name})`.slice(0, 200), lines }, uid);
    }
    await audit(tx, { entity: "product-import", entityId: plan.file.id, action: "import", after: { file: plan.file.name, sheet: plan.sheet, created, variants, photos, stock, skipped: plan.counts.exists + plan.counts.errors }, userId: uid });
  });
  return { created, variants, skipped: plan.counts.exists + plan.counts.errors, photos, stock };
}
