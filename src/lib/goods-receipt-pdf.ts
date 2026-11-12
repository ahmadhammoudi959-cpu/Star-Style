import "server-only";
import { PDFDocument, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Dict } from "@/i18n/de";
import {
  BLUE, BRAND, CONTENT_BOTTOM, CONTENT_TOP, H, INK, LINE, MM, RED, SOFT, W, WHITE,
  drawFooterBand, drawHeaderBand, drawSpaced, embedBandLogo, fonts, hasArabic, roundRect, spacedWidth, wrap,
  type BandHead, type Fonts, type TFont,
} from "./pdf";
import { formatCents } from "./money";
import { formatDate } from "./dates";
import { formatWeight, shipmentWeight } from "./weight";

/**
 * Wareneingang als PDF im Rahmen aller Belege (Kopf-/Fußband in Markenfarbe, Firmendaten unten, Tabellenkopf Nachtblau,
 * Summe im blauen Kasten) – Wunsch Inhaber 12.11.2026. Interner Beleg, darum in der Sprache des Nutzers; Arabisch von
 * rechts nach links (alles gespiegelt). Zahlen/Datum deutsch.
 */
export type GoodsReceiptLine = {
  name: string; variant: string; code: string; qty: number; costCents: number; batchNo: string; expiry: string | null; weightGrams: number | null;
};
export type GoodsReceiptDoc = {
  number: string; date: string; supplierInvoiceNo: string; note: string;
  supplier: { name: string; street: string; zip: string; city: string; country: string } | null;
  lines: GoodsReceiptLine[];
};
type Company = {
  name: string; street: string; zip: string; city: string; owner: string; email: string; phone: string; website: string;
  bankName: string; iban: string; bic: string; vatId: string; taxNumber: string; logoFileId: string | null;
};
export type GoodsReceiptOpts = { t: Dict; lang: string; company: Company };

const L = 20 * MM, R = W - 20 * MM, CW = R - L; // Ränder wie auf der Rechnung, Inhaltsbreite 170 mm
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Seite mit Koordinaten ab dem Anfangsrand: links (LTR) bzw. rechts (RTL) – so wird Arabisch einfach gespiegelt */
class Sheet {
  page!: PDFPage;
  pages: PDFPage[] = [];
  y = 0;
  constructor(private doc: PDFDocument, public f: Fonts, private logo: { img: PDFImage; tile: boolean } | null, public rtl: boolean, private brandName: string, private head: BandHead) {}
  /** Text, der `s` nach dem Anfangsrand beginnt */
  start(t: string, s: number, y: number, size = 9, font: TFont = this.f.r, color: RGB = INK, spacing = 0) {
    const w = spacedWidth(font, t, size, spacing);
    drawSpaced(this.page, font, t, { x: this.rtl ? R - s - w : L + s, y, size, color, spacing });
    return w;
  }
  /** Text, der `e` nach dem Anfangsrand endet (Zahlenspalten) */
  end(t: string, e: number, y: number, size = 9, font: TFont = this.f.r, color: RGB = INK, spacing = 0) {
    const w = spacedWidth(font, t, size, spacing);
    drawSpaced(this.page, font, t, { x: this.rtl ? R - e : L + e - w, y, size, color, spacing });
    return w;
  }
  /** Kopf-Beschriftung: lateinisch in gesperrten Großbuchstaben (wie auf der Rechnung), Arabisch unverändert */
  caps(t: string) { return hasArabic(t) ? t : t.toLocaleUpperCase("de-DE"); }
  rect(s1: number, s2: number, y: number, h: number, color: RGB) {
    this.page.drawRectangle({ x: this.rtl ? R - s2 : L + s1, y, width: s2 - s1, height: h, color });
  }
  line(s1: number, s2: number, y: number, thickness = 0.4, color: RGB = LINE) {
    const x = (s: number) => (this.rtl ? R - s : L + s);
    this.page.drawLine({ start: { x: x(s1), y }, end: { x: x(s2), y }, thickness, color });
  }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    drawHeaderBand(this.page, this.f, this.logo, this.head, this.brandName, this.rtl);
    this.y = CONTENT_TOP;
  }
  ensure(space: number, onBreak?: () => void) {
    if (this.y - space < CONTENT_BOTTOM) { this.newPage(); onBreak?.(); }
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
  const f = await fonts(doc, hasArabic(JSON.stringify(d) + JSON.stringify(r) + JSON.stringify(t.common) + JSON.stringify(t.pdf) + t.product.initialNote + JSON.stringify(o.company)));
  const s = new Sheet(doc, f, await embedBandLogo(doc, o.company.logoFileId), rtl, o.company.name, { label: r.title, number: d.number, date: formatDate(d.date) });
  s.newPage();

  // Lieferant (wo auf der Rechnung die Anschrift steht)
  s.start(s.caps(r.supplier), 0, H - 51 * MM, 6.5, f.s, BLUE, 1.1);
  const sup = d.supplier;
  const addr = sup ? [sup.name, sup.street, [sup.zip, sup.city].filter(Boolean).join(" "), countryLabel(sup.country, o.lang)].filter(Boolean) : [t.common.none];
  addr.forEach((l, i) => s.start(l, 0, H - 56.5 * MM - i * 4.9 * MM, i === 0 ? 10.5 : 10, i === 0 ? f.s : f.r));

  // Infoblock: Zeilen mit feiner Linie; lange Bezeichnungen umbrechen statt in die Werte zu laufen
  const info: [string, string][] = [[r.number, d.number], [t.common.date, formatDate(d.date)]];
  if (d.supplierInvoiceNo) info.push([r.supplierInvoice, d.supplierInvoiceNo]);
  info.push([r.items, String(d.lines.length)]);
  const I0 = 98 * MM; // Beginn des Infoblocks (wie 118 mm auf der Rechnung)
  let iy = H - 48 * MM;
  for (const [k, v] of info) {
    const vw = f.s.widthOfTextAtSize(v, 8.5);
    const labels = wrap(k, f.r, 8, Math.max(22 * MM, CW - I0 - vw - 3 * MM));
    s.end(v, CW, iy, 8.5, f.s);
    labels.forEach((l, i) => s.start(l, I0, iy - i * 3.6 * MM, 8, f.r, SOFT));
    const bottom = iy - (labels.length - 1) * 3.6 * MM;
    s.line(I0, CW, bottom - 2.3 * MM);
    iy = bottom - 6.3 * MM;
  }

  // Titel mit Logo-Linie, Hinweis (z. B. „Anfangsbestand beim Anlegen“)
  s.y = Math.min(H - 97 * MM, iy - 8 * MM, H - 56.5 * MM - addr.length * 4.9 * MM - 12 * MM);
  s.start(title, 0, s.y, 21, f.b, BRAND);
  s.rect(0, 13 * MM, s.y - 4.2 * MM, 1.1 * MM, BLUE);
  s.rect(13 * MM, 18 * MM, s.y - 4.2 * MM, 1.1 * MM, RED);
  s.y -= 12.5 * MM;
  const intro = d.note === "Anfangsbestand beim Anlegen" ? t.product.initialNote : d.note;
  if (intro) {
    for (const l of wrap(intro, f.r, 9.5, CW)) { s.ensure(5 * MM); s.start(l, 0, s.y, 9.5); s.y -= 5 * MM; }
    s.y -= 4 * MM;
  } else s.y -= 1 * MM;

  // Tabelle: # · Artikel · Menge · EK / Stück · Betrag – Kopf Nachtblau mit runden Ecken, Zeilen mit feiner Linie
  const C = { pos: 2 * MM, desc: 11 * MM, descW: 83 * MM, qty: 112 * MM, cost: 140 * MM, total: CW - 2.5 * MM };
  const head = () => {
    roundRect(s.page, L, s.y - 2.7 * MM, CW, 8.2 * MM, 1.6 * MM, BRAND);
    const hs = (txt: string, width: number) => Math.max(6, Math.min(7, (7 * width) / Math.max(1, spacedWidth(f.s, txt, 7, 0.6))));
    s.start("#", C.pos, s.y, 7, f.s, WHITE);
    s.start(s.caps(r.colItem), C.desc, s.y, hs(s.caps(r.colItem), C.descW), f.s, WHITE, 0.6);
    s.end(s.caps(t.common.qty), C.qty, s.y, hs(s.caps(t.common.qty), 16 * MM), f.s, WHITE, 0.6);
    s.end(s.caps(r.colCost), C.cost, s.y, hs(s.caps(r.colCost), 25 * MM), f.s, WHITE, 0.6);
    s.end(s.caps(r.colAmount), C.total, s.y, hs(s.caps(r.colAmount), 25 * MM), f.s, WHITE, 0.6);
    s.y -= 9 * MM;
  };
  head();
  const SEP = "  ·  ";
  d.lines.forEach((l, i) => {
    const name = l.variant ? `${l.name} – ${l.variant}` : l.name;
    const rows = wrap(name, f.s, 9, C.descW);
    const parts = [l.code, l.batchNo && `${r.batchNo}: ${l.batchNo}`, l.expiry && `${r.expiry}: ${formatDate(l.expiry)}`].filter(Boolean) as string[];
    const sub = packParts(parts, f.r, 7.5, C.descW, SEP);
    const h = rows.length * 4.4 * MM + sub.length * 3.8 * MM + 3.2 * MM;
    s.ensure(h, head);
    let y = s.y;
    rows.forEach((row) => { s.start(row, C.desc, y, 9, f.s); y -= 4.4 * MM; });
    sub.forEach((ps) => {
      let at = C.desc;
      ps.forEach((p, pi) => { if (pi) at += s.start(SEP, at, y + 0.5 * MM, 7.5, f.r, SOFT); at += s.start(p, at, y + 0.5 * MM, 7.5, f.r, SOFT); });
      y -= 3.8 * MM;
    });
    s.start(String(i + 1), C.pos, s.y, 9, f.r, SOFT);
    s.end(String(l.qty), C.qty, s.y, 9);
    s.end(formatCents(l.costCents), C.cost, s.y, 9);
    s.end(formatCents(l.qty * l.costCents), C.total, s.y, 9, f.b);
    s.line(0, CW, y + 1.6 * MM);
    s.y = y - 1.6 * MM;
  });

  // Gesamtmenge, Gewicht, Warenwert (blauer Kasten wie „Gesamtbetrag“)
  const qty = d.lines.reduce((a, l) => a + l.qty, 0);
  const value = d.lines.reduce((a, l) => a + l.qty * l.costCents, 0);
  const sw = shipmentWeight(d.lines.map((l) => ({ qty: l.qty, weightGrams: l.weightGrams })));
  s.ensure(36 * MM);
  s.y -= 3 * MM;
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
  const aw = f.b.widthOfTextAtSize(amount, 12);
  const ls = Math.max(7.5, Math.min(10.5, (10.5 * (CW - 96 * MM - aw - 8 * MM)) / Math.max(1, f.b.widthOfTextAtSize(r.valueNet, 10.5))));
  roundRect(s.page, rtl ? L : L + 92 * MM, s.y - 3.6 * MM, CW - 92 * MM, 10.5 * MM, 1.8 * MM, BLUE);
  s.start(r.valueNet, 96 * MM, s.y, ls, f.b, WHITE);
  s.end(amount, CW - 4 * MM, s.y - 0.3 * MM, 12, f.b, WHITE);
  s.y -= 14 * MM;

  // Unterschrift beim Einlagern
  s.ensure(24 * MM);
  s.y -= 12 * MM;
  s.line(0, 95 * MM, s.y, 0.6, SOFT);
  s.start(r.checkedBy, 0, s.y - 4 * MM, 7.5, f.r, SOFT);
  s.line(115 * MM, CW, s.y, 0.6, SOFT);
  s.start(t.common.date, 115 * MM, s.y - 4 * MM, 7.5, f.r, SOFT);

  // Fußband mit allen Firmendaten (wie auf der Rechnung), Beschriftungen in der Sprache des Nutzers
  const p = t.pdf;
  s.pages.forEach((pg, i) => drawFooterBand(pg, f, o.company, i + 1, s.pages.length,
    { thanks: p.thanks, contact: p.contact, bank: p.bank, tax: p.tax, owner: p.owner, phone: p.phone, page: r.page }, rtl));
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
    name: cs?.name ?? "", street: cs?.street ?? "", zip: cs?.zip ?? "", city: cs?.city ?? "", owner: cs?.owner ?? "",
    email: cs?.email ?? "", phone: cs?.phone ?? "", website: cs?.website ?? "", bankName: cs?.bankName ?? "", iban: cs?.iban ?? "",
    bic: cs?.bic ?? "", vatId: cs?.vatId ?? "", taxNumber: cs?.taxNumber ?? "", logoFileId: cs?.logoFileId ?? null,
  };
  const d: GoodsReceiptDoc = {
    number: String(head.number), date: String(head.date), supplierInvoiceNo: String(head.supplier_invoice_no ?? ""), note: String(head.note ?? ""),
    supplier: head.supplier_id ? { name: String(head.name ?? ""), street: String(head.street ?? ""), zip: String(head.zip ?? ""), city: String(head.city ?? ""), country: String(head.country ?? "DE") } : null,
    lines,
  };
  return { number: d.number, bytes: await renderGoodsReceipt(d, { t, lang, company }) };
}
