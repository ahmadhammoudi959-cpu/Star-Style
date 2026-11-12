import "server-only";
import { PDFDocument, rgb, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Dict } from "@/i18n/de";
import { BLUE, BRAND, H, INK, LINE, MM, RED, SOFT, W, ZEBRA, embedLogo, fonts, hasArabic, wrap, type Fonts, type TFont } from "./pdf";
import { formatCents } from "./money";
import { formatDate } from "./dates";
import { formatWeight, shipmentWeight } from "./weight";

/**
 * Wareneingang als PDF im Design der Rechnung (Logo, Kopflinie Blau/Rot, Tabellenkopf Nachtblau, Summe in Blau,
 * Firmenzeile unten) – Wunsch Inhaber 12.11.2026: „wie die Rechnung, mit dem Geist des Logos“. Interner Beleg,
 * darum in der Sprache des Nutzers; Arabisch von rechts nach links (alles gespiegelt). Zahlen/Datum deutsch.
 */
export type GoodsReceiptLine = {
  name: string; variant: string; code: string; qty: number; costCents: number; batchNo: string; expiry: string | null; weightGrams: number | null;
};
export type GoodsReceiptDoc = {
  number: string; date: string; supplierInvoiceNo: string; note: string;
  supplier: { name: string; street: string; zip: string; city: string; country: string } | null;
  lines: GoodsReceiptLine[];
};
type Company = { name: string; street: string; zip: string; city: string; email: string; phone: string; website: string; logoFileId: string | null };
export type GoodsReceiptOpts = { t: Dict; lang: string; company: Company };

const L = 20 * MM, R = W - 20 * MM, CW = R - L; // Ränder wie auf der Rechnung, Inhaltsbreite 170 mm
const WHITE = rgb(1, 1, 1);
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Seite mit Koordinaten ab dem Anfangsrand: links (LTR) bzw. rechts (RTL) – so wird Arabisch einfach gespiegelt */
class Sheet {
  page!: PDFPage;
  pages: PDFPage[] = [];
  y = 0;
  constructor(private doc: PDFDocument, public f: Fonts, private logo: PDFImage | null, public rtl: boolean, private brandName: string) {}
  /** Text, der `s` nach dem Anfangsrand beginnt */
  start(t: string, s: number, y: number, size = 9, font: TFont = this.f.r, color: RGB = INK) {
    const w = font.widthOfTextAtSize(t, size);
    font.draw(this.page, t, { x: this.rtl ? R - s - w : L + s, y, size, color });
    return w;
  }
  /** Text, der `e` nach dem Anfangsrand endet (Zahlenspalten) */
  end(t: string, e: number, y: number, size = 9, font: TFont = this.f.r, color: RGB = INK) {
    const w = font.widthOfTextAtSize(t, size);
    font.draw(this.page, t, { x: this.rtl ? R - e : L + e - w, y, size, color });
    return w;
  }
  rect(s1: number, s2: number, y: number, h: number, color: RGB) {
    this.page.drawRectangle({ x: this.rtl ? R - s2 : L + s1, y, width: s2 - s1, height: h, color });
  }
  line(s1: number, s2: number, y: number, thickness = 0.5, color: RGB = LINE) {
    const x = (s: number) => (this.rtl ? R - s : L + s);
    this.page.drawLine({ start: { x: x(s1), y }, end: { x: x(s2), y }, thickness, color });
  }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.y = H - 40 * MM; // unter dem Logo (bis 20 mm hoch, endet bei 32 mm) – sonst liegt der Tabellenkopf darauf
    if (this.logo) {
      const sc = Math.min((55 * MM) / this.logo.width, (20 * MM) / this.logo.height);
      const w = this.logo.width * sc, h = this.logo.height * sc;
      this.page.drawImage(this.logo, { x: this.rtl ? R - w : L, y: H - 12 * MM - h, width: w, height: h });
    } else this.start(this.brandName || "Star Style", 0, H - 20 * MM, 16, this.f.b, BRAND);
    // Kopflinie in Logo-Farben wie auf der Rechnung: Blau – Rot (in RTL gespiegelt)
    const blue = W * 0.72;
    this.page.drawRectangle({ x: this.rtl ? W - blue : 0, y: H - 6, width: blue, height: 6, color: BLUE });
    this.page.drawRectangle({ x: this.rtl ? 0 : blue, y: H - 6, width: W - blue, height: 6, color: RED });
  }
  ensure(space: number, onBreak?: () => void) {
    if (this.y - space < 32 * MM) { this.newPage(); onBreak?.(); }
  }
}

/** Kurze Texte nebeneinander („Barcode · Charge · MHD“), bei Platzmangel in die nächste Zeile */
function packParts(parts: string[], font: TFont, size: number, width: number, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], used = 0;
  const sepW = font.widthOfTextAtSize(sep, size);
  for (const p of parts) {
    const w = font.widthOfTextAtSize(p, size);
    if (row.length && used + sepW + w > width) { rows.push(row); row = []; used = 0; }
    used += (row.length ? sepW : 0) + w;
    row.push(p);
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Ländername in der Sprache des Nutzers; Deutschland (eigenes Land) wie auf der Rechnung weglassen */
function countryLabel(code: string, lang: string) {
  if (!code || code === "DE") return "";
  try { return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code; } catch { return code; }
}

export async function renderGoodsReceipt(d: GoodsReceiptDoc, o: GoodsReceiptOpts): Promise<Uint8Array> {
  const { t } = o, r = t.receive;
  const rtl = o.lang === "ar";
  const doc = await PDFDocument.create();
  const title = `${r.title} ${d.number}`;
  doc.setTitle(title);
  doc.setLanguage(o.lang === "de" ? "de-DE" : o.lang);
  doc.setAuthor(o.company.name);
  doc.setCreator("Star Style");
  const f = await fonts(doc, hasArabic(JSON.stringify(d) + JSON.stringify(r) + JSON.stringify(t.common) + t.product.initialNote + JSON.stringify(o.company)));
  const s = new Sheet(doc, f, await embedLogo(doc, o.company.logoFileId), rtl, o.company.name);
  s.newPage();

  // Lieferant (wo auf der Rechnung die Anschrift steht)
  s.start(r.supplier, 0, H - 47 * MM, 7, f.r, SOFT);
  s.line(0, 85 * MM, H - 48 * MM, 0.4);
  const sup = d.supplier;
  const addr = sup ? [sup.name, sup.street, [sup.zip, sup.city].filter(Boolean).join(" "), countryLabel(sup.country, o.lang)].filter(Boolean) : [t.common.none];
  addr.forEach((l, i) => s.start(l, 0, H - 54 * MM - i * 4.6 * MM, 10, i === 0 ? f.s : f.r));

  // Infoblock (Ende der Zeile); lange Bezeichnungen umbrechen statt in die Werte zu laufen
  const info: [string, string][] = [[r.number, d.number], [t.common.date, formatDate(d.date)]];
  if (d.supplierInvoiceNo) info.push([r.supplierInvoice, d.supplierInvoiceNo]);
  info.push([r.items, String(d.lines.length)]);
  let iy = H - 50 * MM;
  for (const [k, v] of info) {
    const vw = f.s.widthOfTextAtSize(v, 8.5);
    const labels = wrap(k, f.r, 8.5, Math.max(22 * MM, CW - 105 * MM - vw - 3 * MM));
    s.end(v, CW, iy, 8.5, f.s);
    labels.forEach((l, i) => s.start(l, 105 * MM, iy - i * 3.6 * MM, 8.5, f.r, SOFT));
    iy -= (labels.length - 1) * 3.6 * MM + 4.8 * MM;
  }

  // Titel + Hinweis (z. B. „Anfangsbestand beim Anlegen“)
  s.y = Math.min(H - 100 * MM, iy - 6 * MM, H - 54 * MM - addr.length * 4.6 * MM - 8 * MM);
  s.start(title, 0, s.y, 17, f.b);
  s.y -= 8 * MM;
  const intro = d.note === "Anfangsbestand beim Anlegen" ? t.product.initialNote : d.note;
  if (intro) {
    for (const l of wrap(intro, f.r, 9.5, CW)) { s.ensure(5 * MM); s.start(l, 0, s.y, 9.5); s.y -= 5 * MM; }
    s.y -= 4 * MM;
  } else s.y -= 1 * MM;

  // Tabelle: # · Artikel · Menge · EK / Stück · Betrag (Spalten wie auf der Rechnung)
  const C = { pos: 1.5 * MM, desc: 10 * MM, descW: 84 * MM, qty: 112 * MM, cost: 140 * MM, total: CW - 1.5 * MM };
  const fit = (txt: string, width: number) => Math.max(6.5, Math.min(8, (8 * width) / Math.max(1, f.s.widthOfTextAtSize(txt, 8))));
  const head = () => {
    s.rect(0, CW, s.y - 2.2 * MM, 7 * MM, BRAND);
    s.start("#", C.pos, s.y, 8, f.s, WHITE);
    s.start(r.colItem, C.desc, s.y, fit(r.colItem, C.descW), f.s, WHITE);
    s.end(t.common.qty, C.qty, s.y, fit(t.common.qty, 15 * MM), f.s, WHITE);
    s.end(r.colCost, C.cost, s.y, fit(r.colCost, 25 * MM), f.s, WHITE);
    s.end(r.colAmount, C.total, s.y, fit(r.colAmount, 25 * MM), f.s, WHITE);
    s.y -= 8 * MM;
  };
  head();
  const SEP = "  ·  ";
  d.lines.forEach((l, i) => {
    const name = l.variant ? `${l.name} – ${l.variant}` : l.name;
    const rows = wrap(name, f.s, 9, C.descW);
    const parts = [l.code, l.batchNo && `${r.batchNo}: ${l.batchNo}`, l.expiry && `${r.expiry}: ${formatDate(l.expiry)}`].filter(Boolean) as string[];
    const sub = packParts(parts, f.r, 7.5, C.descW, SEP);
    const h = rows.length * 4.4 * MM + sub.length * 3.8 * MM + 2.6 * MM;
    s.ensure(h, head);
    if (i % 2 === 1) s.rect(0, CW, s.y - h + 3.4 * MM, h, ZEBRA);
    s.start(String(i + 1), C.pos, s.y, 9, f.r, SOFT);
    rows.forEach((row, ri) => s.start(row, C.desc, s.y - ri * 4.4 * MM, 9, f.s));
    sub.forEach((ps, si) => {
      const y = s.y - rows.length * 4.4 * MM - si * 3.8 * MM + 0.4 * MM;
      let at = C.desc;
      ps.forEach((p, pi) => { if (pi) at += s.start(SEP, at, y, 7.5, f.r, SOFT); at += s.start(p, at, y, 7.5, f.r, SOFT); });
    });
    s.end(String(l.qty), C.qty, s.y, 9);
    s.end(formatCents(l.costCents), C.cost, s.y, 9);
    s.end(formatCents(l.qty * l.costCents), C.total, s.y, 9, f.s);
    s.y -= h;
  });
  s.line(0, CW, s.y + 2 * MM, 0.6);

  // Gesamtmenge, Gewicht, Warenwert (blaue Summe wie „Gesamtbetrag“)
  const qty = d.lines.reduce((a, l) => a + l.qty, 0);
  const value = d.lines.reduce((a, l) => a + l.qty * l.costCents, 0);
  const sw = shipmentWeight(d.lines.map((l) => ({ qty: l.qty, weightGrams: l.weightGrams })));
  s.ensure(36 * MM);
  s.y -= 2.5 * MM;
  s.start(fill(r.qtyTotal, { n: d.lines.length }), C.desc, s.y, 9, f.s);
  s.end(String(qty), C.qty, s.y, 9.5, f.b);
  s.y -= 6 * MM;
  if (sw.grams > 0) {
    s.start(r.totalWeight, C.desc, s.y, 9, f.s);
    s.end(formatWeight(sw.grams), C.qty, s.y, 9.5, f.b);
    s.y -= 6 * MM;
  }
  s.y -= 3 * MM;
  const amount = formatCents(value);
  const aw = f.b.widthOfTextAtSize(amount, 10.5);
  const ls = Math.max(7.5, Math.min(10.5, (10.5 * (CW - 95 * MM - aw - 6 * MM)) / Math.max(1, f.b.widthOfTextAtSize(r.valueNet, 10.5))));
  s.rect(92 * MM, CW, s.y - 3 * MM, 9 * MM, BLUE);
  s.start(r.valueNet, 95 * MM, s.y, ls, f.b, WHITE);
  s.end(amount, C.total, s.y, 10.5, f.b, WHITE);
  s.y -= 13 * MM;

  // Unterschrift beim Einlagern
  s.ensure(24 * MM);
  s.y -= 12 * MM;
  s.line(0, 95 * MM, s.y, 0.6, INK);
  s.start(r.checkedBy, 0, s.y - 4 * MM, 7.5, f.r, SOFT);
  s.line(115 * MM, CW, s.y, 0.6, INK);
  s.start(t.common.date, 115 * MM, s.y - 4 * MM, 7.5, f.r, SOFT);

  // Fußzeile wie auf der Rechnung (ohne Bankdaten – interner Beleg)
  const c = o.company;
  const cols = [[c.name, c.street, [c.zip, c.city].filter(Boolean).join(" ")], [c.email, c.website, c.phone]];
  s.pages.forEach((p, i) => {
    s.page = p;
    s.line(0, CW, 24 * MM, 0.5);
    cols.forEach((col, ci) => col.filter(Boolean).forEach((l, li) => s.start(l, ci * 60 * MM, 20 * MM - li * 3.6 * MM, 7, f.r, SOFT)));
    s.end(fill(r.page, { n: i + 1, m: s.pages.length }), CW, 8 * MM, 7, f.r, SOFT);
  });
  return doc.save();
}

/** Daten laden und rendern; null = Wareneingang gibt es nicht */
export async function goodsReceiptPdf(id: string, t: Dict, lang: string): Promise<{ number: string; bytes: Uint8Array } | null> {
  const head = (await db.execute<Record<string, unknown>>(sql`
    select r.number, to_char(r.date, 'YYYY-MM-DD') as date, r.supplier_invoice_no, r.note,
           s.id as supplier_id, s.name, s.street, s.zip, s.city, s.country
    from goods_receipts r left join suppliers s on s.id = r.supplier_id where r.id = ${id}`)).rows[0];
  if (!head) return null;
  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.qty, l.unit_cost_cents, l.batch_no, to_char(l.expiry_date, 'YYYY-MM-DD') as expiry, p.name_de, p.sku, v.size, v.color, v.barcode, v.weight_grams
    from receipt_lines l join variants v on v.id = l.variant_id join products p on p.id = v.product_id
    where l.receipt_id = ${id} order by p.name_de, v.created_at`)).rows.map((x): GoodsReceiptLine => ({
    name: String(x.name_de), variant: [x.size, x.color].filter(Boolean).join(" · "), code: String(x.barcode || x.sku || ""),
    qty: Number(x.qty), costCents: Number(x.unit_cost_cents), batchNo: String(x.batch_no ?? ""), expiry: (x.expiry as string) ?? null,
    weightGrams: x.weight_grams == null ? null : Number(x.weight_grams),
  }));
  const cs = await db.query.companySettings.findFirst();
  const company: Company = {
    name: cs?.name ?? "", street: cs?.street ?? "", zip: cs?.zip ?? "", city: cs?.city ?? "",
    email: cs?.email ?? "", phone: cs?.phone ?? "", website: cs?.website ?? "", logoFileId: cs?.logoFileId ?? null,
  };
  const d: GoodsReceiptDoc = {
    number: String(head.number), date: String(head.date), supplierInvoiceNo: String(head.supplier_invoice_no ?? ""), note: String(head.note ?? ""),
    supplier: head.supplier_id ? { name: String(head.name ?? ""), street: String(head.street ?? ""), zip: String(head.zip ?? ""), city: String(head.city ?? ""), country: String(head.country ?? "DE") } : null,
    lines,
  };
  return { number: d.number, bytes: await renderGoodsReceipt(d, { t, lang, company }) };
}
