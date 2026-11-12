import "server-only";
/**
 * Vorschau im Belegdesign (Seite „Belegdesign“): ein Beispielbeleg mit den echten Firmendaten und dem Logo, gerendert mit dem
 * gerade bearbeiteten (noch nicht gespeicherten) Design – als PDF oder als Bild der ersten Seite (pdf.js auf dem Server,
 * Zeichnen mit @napi-rs/canvas). Beispielpositionen: ein paar echte Artikel (mit Foto fürs Angebot), sonst feste Beispiele.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { renderLetter, renderPdf, type DocData } from "./pdf";
import { addDaysIso, formatDate, todayIso } from "./dates";
import { formatCents } from "./money";
import type { DocDesign, PreviewKind } from "./doc-design";

const BUYER = { name: "Salon Beispiel GmbH", street: "Musterstraße 1", zip: "44135", city: "Dortmund", country: "DE", vatId: "DE123456789" };

type SampleLine = DocData["lines"][number];
const FALLBACK: { description: string; category: string; qty: number; price: number; ean: string }[] = [
  { description: "Barberstuhl Classic – Schwarz", category: "Barberstühle", qty: 2, price: 46000, ean: "4260123450028" },
  { description: "Spiegel mit LED-Beleuchtung", category: "Spiegel & Bedienplätze", qty: 1, price: 36000, ean: "4260123450011" },
  { description: "Profi-Haarschneidemaschine mit Akku", category: "Maschinen & Föhne", qty: 3, price: 7990, ean: "4012345678901" },
];

/** drei echte Artikel (mit Foto zuerst), sonst feste Beispiele */
async function sampleLines(): Promise<SampleLine[]> {
  let rows: Record<string, unknown>[] = [];
  try {
    // drei verschiedene Artikel (je eine Variante, die mit Foto zuerst), Artikel mit Foto zuerst
    rows = (await db.execute<Record<string, unknown>>(sql`
      select * from (
        select distinct on (p.id) p.name_de, p.category, coalesce(v.retail_price_cents, p.retail_price_cents) as retail_price_cents, p.vat_rate_bp,
          coalesce(v.image_file_id, p.image_file_id) as image, coalesce(v.barcode, p.sku) as code, p.created_at
        from products p join variants v on v.product_id = p.id
        where p.active and v.active and coalesce(v.retail_price_cents, p.retail_price_cents) > 0
        order by p.id, (coalesce(v.image_file_id, p.image_file_id) is null)
      ) x order by (image is null), created_at limit 3`)).rows;
  } catch { rows = []; }
  const src = rows.length >= 2
    ? rows.map((r, i) => ({ description: String(r.name_de), category: String(r.category ?? ""), qty: [2, 1, 3][i], price: Number(r.retail_price_cents), ean: String(r.code ?? ""), image: (r.image as string) ?? null, vat: Number(r.vat_rate_bp) || 1900 }))
    : FALLBACK.map((x) => ({ ...x, image: null as string | null, vat: 1900 }));
  return src.map((x, i) => {
    const netCents = x.qty * x.price;
    return { position: i + 1, sku: x.ean, ean: x.ean, category: x.category, imageFileId: x.image, description: x.description, qty: x.qty,
      unitPriceCents: x.price, discountBp: 0, netCents, vatRateBp: x.vat, vatCents: Math.round((netCents * x.vat) / 10000), weightGrams: 2500 };
  });
}

/** Beispielbeleg als PDF mit dem übergebenen Design */
export async function previewPdf(kind: PreviewKind, design: DocDesign): Promise<Uint8Array> {
  const today = todayIso(), year = today.slice(0, 4);
  const lines = await sampleLines();
  const net = lines.reduce((s, l) => s + l.netCents, 0);
  const byRate = new Map<number, { net: number; vat: number }>();
  for (const l of lines) { const g = byRate.get(l.vatRateBp) ?? { net: 0, vat: 0 }; g.net += l.netCents; g.vat += l.vatCents ?? 0; byRate.set(l.vatRateBp, g); }
  const vat = [...byRate.values()].reduce((s, g) => s + g.vat, 0);
  const base: Omit<DocData, "kind" | "number"> = {
    date: today, deliveryDate: today, dueDate: addDaysIso(today, 14), validUntil: null, customerNo: 7, customerId: "preview", buyer: BUYER, lines,
    subtotalCents: net, discountCents: 0, discountBp: 0, netCents: net, vatCents: vat, grossCents: net + vat,
    vatBreakdown: [...byRate.entries()].map(([rateBp, g]) => ({ rateBp, netCents: g.net, vatCents: g.vat })),
    taxMode: "DOMESTIC", ossCountry: null, retentionOfTitle: true, notes: "", refNumber: null, received: [],
  };
  const gross = formatCents(net + vat), head = (label: string, number: string) => ({ label, number, date: formatDate(today) });
  switch (kind) {
    case "offer": return renderPdf({ ...base, kind: "offer", number: `AN-${year}-0001`, deliveryDate: null, dueDate: null, validUntil: addDaysIso(today, 14) }, { design });
    case "cancellation": return renderPdf({ ...base, kind: "cancellation", number: `ST-${year}-0001`, refNumber: `RE-${year}-0001` }, { design });
    case "delivery": return renderPdf({ ...base, kind: "delivery", number: `RE-${year}-0001` }, { design });
    case "receipt": return renderLetter({
      title: `Quittung QU-${year}-0001`, head: head("Quittung", `QU-${year}-0001`), buyer: BUYER,
      info: [["Quittungsnr.", `QU-${year}-0001`], ["Datum", formatDate(today)], ["Zu Rechnung", `RE-${year}-0001`], ["Kundennr.", "7"]],
      paragraphs: [`Wir bestätigen den Eingang von ${formatCents(20000)} (bar) am ${formatDate(today)} für die Rechnung RE-${year}-0001 vom ${formatDate(today)}.`],
      table: { head: ["", "Betrag"], widths: [120, 50], rows: [["Rechnungsbetrag", gross], ["Bereits vorher bezahlt", formatCents(0)], ["Diese Zahlung", formatCents(20000)]] },
      total: ["Noch offen", formatCents(net + vat - 20000)], signature: true,
    }, { design });
    case "dunning": return renderLetter({
      title: "Zahlungserinnerung", head: head("Zahlungserinnerung", `RE-${year}-0001`), buyer: BUYER,
      info: [["Datum", formatDate(today)], ["Rechnungsnr.", `RE-${year}-0001`], ["Kundennr.", "7"], ["Zahlbar bis", formatDate(addDaysIso(today, 7))]],
      paragraphs: ["Sehr geehrte Damen und Herren,", "sicher haben Sie es im Tagesgeschäft übersehen: Für die folgende Rechnung konnten wir bis heute keinen vollständigen Zahlungseingang feststellen."],
      table: { head: ["Position", "Betrag"], widths: [120, 50], rows: [[`Rechnung RE-${year}-0001 vom ${formatDate(today)} – fälliger, unbezahlter Betrag`, gross]] },
      total: ["Zu zahlen", gross],
      afterTable: [`Bitte überweisen Sie den Betrag bis zum ${formatDate(addDaysIso(today, 7))} unter Angabe der Rechnungsnummer RE-${year}-0001.`],
    }, { design });
    default: return renderPdf({ ...base, kind: "invoice", number: `RE-${year}-0001` }, { design });
  }
}

// Eine Vorschau nach der anderen (Rechenzeit), der Browser wartet ohnehin kurz nach der letzten Änderung
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => { const run = queue.then(job, job); queue = run.catch(() => undefined); return run; };

type PdfJsCanvas = { encode(format: "png"): Promise<Buffer> };
type PdfJsDoc = {
  numPages: number;
  getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: unknown): { promise: Promise<void> } }>;
  canvasFactory: { create(w: number, h: number): { canvas: PdfJsCanvas; context: unknown } };
};

/** erste Seite als PNG (Breite ≈ 830 px bei scale 1.4) */
export async function pdfToPng(bytes: Uint8Array, scale = 1.4): Promise<Buffer> {
  return serial(async () => {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as { getDocument(o: unknown): { promise: Promise<PdfJsDoc>; destroy(): Promise<void> } };
    // pdf.js 6: aufräumen über die Ladeaufgabe (das Dokument selbst hat kein destroy() mehr)
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    const pdf = await task.promise;
    try {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale });
      const { canvas, context } = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      return await canvas.encode("png");
    } finally {
      await task.destroy();
    }
  });
}
