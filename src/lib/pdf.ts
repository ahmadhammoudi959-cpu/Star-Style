import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AFRelationship, PDFDocument, PDFFont, PDFName, PDFPage, rgb, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents, bpToPercent } from "./money";
import { addDaysIso, formatDate } from "./dates";
import { legalNotes, skontoAmount } from "./tax";
import { buildCiiXml } from "./einvoice";

const MM = 2.8346;
const W = 595.28, H = 841.89;
const BRAND = rgb(0.059, 0.416, 0.345);
const INK = rgb(0.114, 0.141, 0.2);
const SOFT = rgb(0.36, 0.39, 0.46);
const LINE = rgb(0.85, 0.87, 0.9);
const ZEBRA = rgb(0.955, 0.972, 0.965);

type Fonts = { r: PDFFont; s: PDFFont; b: PDFFont };
type DocKind = "invoice" | "cancellation" | "offer" | "delivery";

type Party = { name: string; street: string; zip: string; city: string; country: string; vatId: string };
type Line = { position: number; sku: string; ean: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; netCents: number; vatRateBp: number; vatCents?: number };
type DocData = {
  kind: DocKind; number: string; date: string; deliveryDate: string | null; dueDate: string | null; validUntil: string | null;
  customerNo: number; customerId: string; buyer: Party; lines: Line[];
  subtotalCents: number; discountCents: number; discountBp: number; netCents: number; vatCents: number; grossCents: number;
  vatBreakdown: { rateBp: number; netCents: number; vatCents: number }[];
  taxMode: "DOMESTIC" | "EU_REVERSE_CHARGE" | "EU_PENDING_VATID" | "EU_B2C" | "EXPORT"; ossCountry: string | null;
  skontoBp: number; skontoDays: number; retentionOfTitle: boolean; notes: string; refNumber: string | null;
  /** nur Rechnung: bei Ausstellung bereits erhaltene Zahlungen und Ratenplan */
  received?: { amountCents: number; method: string }[]; installments?: { dueDate: string; amountCents: number }[];
  /** Positionen mit Bruttopreisen (Shop-Bestellungen) */
  pricesGross?: boolean;
};
const METHOD_DE: Record<string, string> = { CASH: "bar", BANK: "per Überweisung", CARD: "per Karte", ONLINE: "online" };

const COUNTRY: Record<string, string> = { DE: "", NL: "Niederlande", BE: "Belgien", AT: "Österreich", FR: "Frankreich", LU: "Luxemburg", PL: "Polen", CH: "Schweiz", IT: "Italien", ES: "Spanien", DK: "Dänemark", CZ: "Tschechien" };
const countryName = (c: string) => (c === "DE" ? "" : COUNTRY[c] ?? c);

async function fonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const dir = path.join(process.cwd(), "assets", "fonts");
  const load = (f: string) => doc.embedFont(fs.readFileSync(path.join(dir, f)), { subset: true });
  return { r: await load("IBMPlexSans-Regular.woff"), s: await load("IBMPlexSans-SemiBold.woff"), b: await load("IBMPlexSans-Bold.woff") };
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= width) line = test;
      else { if (line) out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  pages: PDFPage[] = [];
  constructor(public doc: PDFDocument, public f: Fonts, public company: typeof schema.companySettings.$inferSelect, public logo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null) {}

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.pageNo++;
    this.y = H - 20 * MM;
    // Kopf: Marke links, farbige Linie
    if (this.logo) {
      const s = Math.min((45 * MM) / this.logo.width, (16 * MM) / this.logo.height);
      this.page.drawImage(this.logo, { x: 20 * MM, y: H - 12 * MM - this.logo.height * s, width: this.logo.width * s, height: this.logo.height * s });
    } else {
      this.text(this.company.name || "Firma", 20 * MM, H - 20 * MM, 16, this.f.b, BRAND);
    }
    this.page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: BRAND });
  }
  text(t: string, x: number, y: number, size = 9, font = this.f.r, color: RGB = INK) {
    this.page.drawText(t, { x, y, size, font, color });
  }
  right(t: string, xRight: number, y: number, size = 9, font = this.f.r, color: RGB = INK) {
    this.page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  }
  ensure(space: number, onBreak?: () => void) {
    if (this.y - space < 32 * MM) { this.newPage(); this.y = H - 32 * MM; onBreak?.(); }
  }
  footer() {
    const c = this.company;
    const cols = [
      [c.name, c.street, [c.zip, c.city].filter(Boolean).join(" "), c.owner ? `Inhaber: ${c.owner}` : ""],
      [c.phone ? `Tel. ${c.phone}` : "", c.email, c.website],
      [c.bankName, c.iban ? `IBAN ${c.iban.replace(/(.{4})/g, "$1 ").trim()}` : "", c.bic ? `BIC ${c.bic}` : "", [c.vatId && `USt-IdNr. ${c.vatId}`, c.taxNumber && `St.-Nr. ${c.taxNumber}`].filter(Boolean).join(" · ")],
    ];
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: 20 * MM, y: 24 * MM }, end: { x: W - 20 * MM, y: 24 * MM }, thickness: 0.5, color: LINE });
      cols.forEach((col, ci) => {
        col.filter(Boolean).forEach((l, li) => p.drawText(l, { x: 20 * MM + ci * 60 * MM, y: 20 * MM - li * 3.6 * MM, size: 7, font: this.f.r, color: SOFT }));
      });
      const pn = `Seite ${i + 1} von ${this.pages.length}`;
      p.drawText(pn, { x: W - 20 * MM - this.f.r.widthOfTextAtSize(pn, 7), y: 8 * MM, size: 7, font: this.f.r, color: SOFT });
    });
  }
}

const TITLES: Record<DocKind, string> = { invoice: "Rechnung", cancellation: "Stornorechnung", offer: "Angebot", delivery: "Ladeliste / Lieferschein" };

export async function renderPdf(d: DocData, opts: { xml?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${TITLES[d.kind]} ${d.number}`);
  doc.setLanguage("de-DE");
  const f = await fonts(doc);
  const company = (await db.query.companySettings.findFirst()) ?? ({ name: "", street: "", zip: "", city: "", country: "DE", owner: "", email: "", phone: "", website: "", vatId: "", taxNumber: "", bankName: "", iban: "", bic: "", logoFileId: null, invoiceFooter: "", defaultPaymentDays: 14, offerValidityDays: 14, id: "company", updatedAt: new Date() } as typeof schema.companySettings.$inferSelect);
  let logo = null;
  if (company.logoFileId) {
    const file = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, company.logoFileId) });
    if (file?.mime === "image/png") logo = await doc.embedPng(file.data);
    else if (file?.mime === "image/jpeg") logo = await doc.embedJpg(file.data);
  }
  doc.setAuthor(company.name);
  doc.setCreator("Star Style");
  const w = new Writer(doc, f, company, logo);
  w.newPage();

  // Absenderzeile + Anschriftfeld (DIN 5008)
  const sender = [company.name, company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  w.text(sender, 20 * MM, H - 47 * MM, 7, f.r, SOFT);
  w.page.drawLine({ start: { x: 20 * MM, y: H - 48 * MM }, end: { x: 105 * MM, y: H - 48 * MM }, thickness: 0.4, color: LINE });
  const addr = [d.buyer.name, d.buyer.street, [d.buyer.zip, d.buyer.city].filter(Boolean).join(" "), countryName(d.buyer.country)].filter(Boolean);
  addr.forEach((l, i) => w.text(l, 20 * MM, H - 54 * MM - i * 4.6 * MM, 10, i === 0 ? f.s : f.r));

  // Infoblock rechts
  const info: [string, string][] = [];
  const label = d.kind === "offer" ? "Angebotsnr." : d.kind === "delivery" ? "Zu Rechnung" : d.kind === "cancellation" ? "Storno-Nr." : "Rechnungsnr.";
  info.push([label, d.number]);
  info.push([d.kind === "offer" ? "Angebotsdatum" : "Datum", formatDate(d.date)]);
  if (d.refNumber) info.push([d.kind === "cancellation" ? "Storno zu" : "Ersetzt", d.refNumber]);
  if (d.deliveryDate && d.kind !== "offer") info.push(["Lieferdatum", formatDate(d.deliveryDate)]);
  if (d.validUntil) info.push(["Gültig bis", formatDate(d.validUntil)]);
  info.push(["Kundennr.", String(d.customerNo)]);
  if (d.buyer.vatId) info.push(["Ihre USt-IdNr.", d.buyer.vatId]);
  if (d.dueDate && d.kind === "invoice") info.push(["Fällig am", formatDate(d.dueDate)]);
  info.forEach(([k, v], i) => {
    w.text(k, 125 * MM, H - 50 * MM - i * 4.8 * MM, 8.5, f.r, SOFT);
    w.right(v, W - 20 * MM, H - 50 * MM - i * 4.8 * MM, 8.5, f.s);
  });

  // Titel
  w.y = H - 100 * MM;
  w.text(`${TITLES[d.kind]} ${d.kind === "delivery" ? "" : d.number}`.trim(), 20 * MM, w.y, 17, f.b, INK);
  w.y -= 8 * MM;
  const intro = d.kind === "offer" ? "vielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen an:"
    : d.kind === "invoice" ? "vielen Dank für Ihren Auftrag. Wir berechnen Ihnen:"
    : d.kind === "cancellation" ? `hiermit stornieren wir die Rechnung ${d.refNumber ?? ""} vollständig.`
    : "Bitte beim Verladen jede Position prüfen und abhaken.";
  if (d.kind !== "delivery") { w.text("Sehr geehrte Damen und Herren,", 20 * MM, w.y, 9.5); w.y -= 5 * MM; }
  w.text(intro, 20 * MM, w.y, 9.5); w.y -= 9 * MM;

  // Tabelle
  const priced = d.kind !== "delivery";
  const X = { pos: 20 * MM, desc: 30 * MM, qty: priced ? 124 * MM : 150 * MM, price: 150 * MM, disc: 163 * MM, total: W - 20 * MM };
  const descW = (priced ? 92 : 112) * MM;
  const head = () => {
    w.page.drawRectangle({ x: 20 * MM, y: w.y - 2.2 * MM, width: W - 40 * MM, height: 7 * MM, color: BRAND });
    const hy = w.y;
    w.text("Pos.", X.pos + 1.5 * MM, hy, 8, f.s, rgb(1, 1, 1));
    w.text(priced ? "Artikel" : "Art.-Nr. · Artikel", X.desc, hy, 8, f.s, rgb(1, 1, 1));
    w.right("Menge", X.qty + 10 * MM, hy, 8, f.s, rgb(1, 1, 1));
    if (priced) {
      w.right(d.pricesGross ? "Preis brutto" : "Einzelpreis", X.price, hy, 8, f.s, rgb(1, 1, 1));
      w.right("Rabatt", X.disc, hy, 8, f.s, rgb(1, 1, 1));
      w.right(d.pricesGross ? "Betrag brutto" : "Betrag netto", X.total - 1.5 * MM, hy, 8, f.s, rgb(1, 1, 1));
    } else {
      w.right("geladen", X.total - 1.5 * MM, hy, 8, f.s, rgb(1, 1, 1));
    }
    w.y -= 8 * MM;
  };
  head();
  d.lines.forEach((l, i) => {
    const title = priced ? l.description : `${l.sku ? l.sku + " · " : ""}${l.description}`;
    const sub = priced ? [l.sku, l.ean].filter(Boolean).join(" · ") : l.ean ?? "";
    const rows = wrap(title, f.r, 9, descW);
    const h = (rows.length + (sub ? 1 : 0)) * 4.4 * MM + 2.6 * MM;
    w.ensure(h, head);
    if (i % 2 === 1) w.page.drawRectangle({ x: 20 * MM, y: w.y - h + 3.4 * MM, width: W - 40 * MM, height: h, color: ZEBRA });
    w.text(String(l.position), X.pos + 1.5 * MM, w.y, 9, f.r, SOFT);
    rows.forEach((r, ri) => w.text(r, X.desc, w.y - ri * 4.4 * MM, 9, ri === 0 ? f.s : f.r));
    if (sub) w.text(sub, X.desc, w.y - rows.length * 4.4 * MM, 7.5, f.r, SOFT);
    w.right(String(Math.abs(l.qty)), X.qty + 10 * MM, w.y, 9);
    if (priced) {
      w.right(formatCents(l.unitPriceCents), X.price, w.y, 9);
      w.right(l.discountBp ? `${bpToPercent(l.discountBp)} %` : "", X.disc, w.y, 9, f.r, SOFT);
      w.right(formatCents(d.pricesGross ? l.netCents + (l.vatCents ?? 0) : l.netCents), X.total - 1.5 * MM, w.y, 9, f.s);
    } else {
      w.page.drawRectangle({ x: X.total - 7 * MM, y: w.y - 1 * MM, width: 4 * MM, height: 4 * MM, borderColor: INK, borderWidth: 0.7 });
    }
    w.y -= h;
  });
  w.page.drawLine({ start: { x: 20 * MM, y: w.y + 2 * MM }, end: { x: W - 20 * MM, y: w.y + 2 * MM }, thickness: 0.6, color: LINE });

  // Summen
  if (priced) {
    const rows: [string, string, boolean][] = [];
    if (d.discountCents) {
      rows.push(["Zwischensumme", formatCents(d.subtotalCents), false]);
      rows.push([`Rabatt ${bpToPercent(d.discountBp)} %`, `- ${formatCents(Math.abs(d.discountCents))}`, false]);
    }
    rows.push(["Summe netto", formatCents(d.netCents), false]);
    for (const g of d.vatBreakdown) rows.push([`USt. ${bpToPercent(g.rateBp)} % auf ${formatCents(g.netCents)}`, formatCents(g.vatCents), false]);
    w.ensure(rows.length * 5.2 * MM + 14 * MM);
    w.y -= 3 * MM;
    rows.forEach(([k, v]) => { w.text(k, 115 * MM, w.y, 9, f.r, SOFT); w.right(v, W - 21.5 * MM, w.y, 9); w.y -= 5.2 * MM; });
    w.y -= 3 * MM;
    w.page.drawRectangle({ x: 112 * MM, y: w.y - 3 * MM, width: W - 20 * MM - 112 * MM, height: 9 * MM, color: BRAND });
    w.text(d.kind === "offer" ? "Angebotssumme" : "Gesamtbetrag", 115 * MM, w.y, 10.5, f.b, rgb(1, 1, 1));
    w.right(formatCents(d.grossCents), W - 21.5 * MM, w.y, 10.5, f.b, rgb(1, 1, 1));
    w.y -= 13 * MM;
  }

  // Hinweise
  const notes: string[] = [];
  if (d.kind === "invoice") {
    const got = (d.received ?? []).reduce((s, p) => s + p.amountCents, 0);
    const rest = d.grossCents - got;
    if (got > 0) {
      const how = [...new Set((d.received ?? []).map((p) => METHOD_DE[p.method] ?? ""))].filter(Boolean).join(" / ");
      notes.push(rest <= 0 ? `Betrag ${how} dankend erhalten. Die Rechnung ist bezahlt.` : `Bereits ${how} erhalten: ${formatCents(got)}. Noch offen: ${formatCents(rest)}.`);
    }
    const plan = d.installments ?? [];
    if (rest > 0 && plan.length > 1) {
      let pool = got;
      const open = plan.map((r) => { const paid = Math.min(pool, r.amountCents); pool -= paid; return { ...r, open: r.amountCents - paid }; }).filter((r) => r.open > 0);
      notes.push(`Ratenzahlung vereinbart: ${open.map((r, i) => `${i + 1}. Rate ${formatCents(r.open)} fällig am ${formatDate(r.dueDate)}`).join("; ")}.`);
    } else if (rest > 0 && d.dueDate) notes.push(`Zahlbar ohne Abzug bis ${formatDate(d.dueDate)}.`);
    if (rest > 0 && d.skontoBp && d.skontoDays) notes.push(`Bei Zahlung bis ${formatDate(addDaysIso(d.date, d.skontoDays))} gewähren wir ${bpToPercent(d.skontoBp)} % Skonto: zu zahlen ${formatCents(skontoAmount(d.grossCents, d.skontoBp))}.`);
    if (d.deliveryDate === d.date) notes.push("Das Lieferdatum entspricht dem Rechnungsdatum.");
    if (d.pricesGross) notes.push("Alle Preise inklusive der ausgewiesenen Umsatzsteuer.");
  }
  if (d.kind === "offer" && d.validUntil) notes.push(`Dieses Angebot ist gültig bis ${formatDate(d.validUntil)}. Die Ware ist bis dahin für Sie reserviert.`);
  if (d.kind !== "delivery") notes.push(...legalNotes(d.taxMode, { ossCountry: d.ossCountry, retentionOfTitle: d.kind === "invoice" && d.retentionOfTitle }));
  if (d.notes) notes.push(d.notes);
  if (company.invoiceFooter && d.kind !== "delivery") notes.push(company.invoiceFooter);
  for (const n of notes) {
    const rows = wrap(n, f.r, 8.5, W - 40 * MM);
    w.ensure(rows.length * 4.2 * MM + 2 * MM);
    rows.forEach((r) => { w.text(r, 20 * MM, w.y, 8.5, f.r, INK); w.y -= 4.2 * MM; });
    w.y -= 1.5 * MM;
  }

  if (d.kind === "delivery") {
    w.ensure(30 * MM);
    w.y -= 14 * MM;
    const boxes = ["Verladen und geprüft von (Name, Unterschrift)", "Ware vollständig erhalten – Kunde / Fahrer"];
    boxes.forEach((b, i) => {
      const x = 20 * MM + i * 90 * MM;
      w.page.drawLine({ start: { x, y: w.y }, end: { x: x + 80 * MM, y: w.y }, thickness: 0.6, color: INK });
      w.text(b, x, w.y - 4 * MM, 7.5, f.r, SOFT);
    });
    w.y -= 12 * MM;
    w.text("Datum: ____________________", 20 * MM, w.y, 9);
  } else if (d.kind !== "cancellation") {
    w.ensure(10 * MM);
    w.y -= 3 * MM;
    w.text("Mit freundlichen Grüßen", 20 * MM, w.y, 9.5); w.y -= 5 * MM;
    w.text(company.name, 20 * MM, w.y, 9.5, f.s);
  }

  w.footer();

  if (opts.xml) {
    await doc.attach(Buffer.from(opts.xml, "utf8"), "factur-x.xml", {
      mimeType: "text/xml", description: "Factur-X/ZUGFeRD Rechnungsdaten (EN 16931)",
      creationDate: new Date(), modificationDate: new Date(), afRelationship: AFRelationship.Alternative,
    });
    setFacturXMetadata(doc, `${TITLES[d.kind]} ${d.number}`, company.name);
  }
  return doc.save();
}

/** XMP-Metadaten, damit Lesegeräte die eingebettete ZUGFeRD-Datei erkennen. */
function setFacturXMetadata(doc: PDFDocument, title: string, author: string) {
  const now = new Date().toISOString();
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator></rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>${now}</xmp:CreateDate><xmp:ModifyDate>${now}</xmp:ModifyDate><xmp:CreatorTool>Star Style</xmp:CreatorTool></rdf:Description>
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const stream = doc.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
}

// ───────────────────────── Daten laden ─────────────────────────

async function linesWithProducts(lines: { position: number; variantId: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; netCents?: number; vatRateBp: number; vatCents?: number }[]) {
  const out: Line[] = [];
  for (const l of lines.sort((a, b) => a.position - b.position)) {
    let sku = "", ean: string | null = null;
    if (l.variantId) {
      const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, l.variantId), with: { product: true } });
      sku = v?.product.sku ?? ""; ean = v?.barcode ?? null;
    }
    const raw = l.qty * l.unitPriceCents;
    out.push({ position: l.position, sku, ean, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, netCents: l.netCents ?? raw - Math.round((raw * l.discountBp) / 10000), vatRateBp: l.vatRateBp, vatCents: l.vatCents });
  }
  return out;
}

export async function invoicePdf(invoiceId: string, variant: "invoice" | "delivery" = "invoice") {
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { lines: true, customer: true, installments: true, payments: true } });
  if (!inv) throw new Error("notFound");
  const isDraft = inv.status === "DRAFT";
  const ref = inv.cancelsInvoiceId
    ? (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.cancelsInvoiceId) }))?.number ?? null
    : inv.replacesInvoiceId ? (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.replacesInvoiceId) }))?.number ?? null : null;
  const c = inv.customer;
  const buyer = isDraft
    ? { name: c.name, street: c.street, zip: c.zip, city: c.city, country: c.country, vatId: c.vatId }
    : { name: inv.custName, street: inv.custStreet, zip: inv.custZip, city: inv.custCity, country: inv.custCountry, vatId: inv.custVatId };
  const kind: DocKind = variant === "delivery" ? "delivery" : inv.kind === "CANCELLATION" ? "cancellation" : "invoice";
  const date = inv.issueDate ?? new Date().toISOString().slice(0, 10);
  const data: DocData = {
    kind, number: inv.number ?? "ENTWURF", date, deliveryDate: inv.deliveryDate ?? date, dueDate: inv.dueDate, validUntil: null,
    customerNo: c.number, customerId: c.id, buyer, lines: await linesWithProducts(inv.lines),
    subtotalCents: inv.subtotalCents, discountCents: inv.discountCents, discountBp: inv.discountBp, netCents: inv.netCents, vatCents: inv.vatCents,
    grossCents: inv.grossCents, vatBreakdown: inv.vatBreakdown, taxMode: inv.taxMode, ossCountry: inv.ossCountry,
    skontoBp: inv.skontoBp, skontoDays: inv.skontoDays, retentionOfTitle: inv.retentionOfTitle, notes: inv.notes, refNumber: ref,
    installments: [...inv.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    pricesGross: inv.pricesGross,
    // Entwurf: geplante Zahlung bei Ausstellung; ausgestellt: Zahlungen bis zum Rechnungsdatum (PDF wird beim ersten Abruf archiviert)
    received: isDraft
      ? (inv.initialPaymentCents > 0 ? [{ amountCents: inv.initialPaymentCents, method: inv.initialPaymentMethod ?? "CASH" }] : [])
      : inv.payments.filter((p) => !p.cancelledAt && p.date <= date).map((p) => ({ amountCents: p.amountCents, method: p.method })),
  };
  if (kind === "delivery" || isDraft) return renderPdf(data);
  const company = await db.query.companySettings.findFirst();
  const xml = buildCiiXml({
    number: data.number, typeCode: kind === "cancellation" ? "381" : "380", issueDate: date, deliveryDate: data.deliveryDate!, dueDate: inv.dueDate,
    notes: legalNotes(inv.taxMode, { ossCountry: inv.ossCountry, retentionOfTitle: inv.retentionOfTitle && kind === "invoice" }),
    seller: { name: company?.name ?? "", street: company?.street ?? "", zip: company?.zip ?? "", city: company?.city ?? "", country: company?.country ?? "DE", vatId: company?.vatId ?? "", taxNumber: company?.taxNumber ?? "", email: company?.email ?? "", iban: company?.iban ?? "", bic: company?.bic ?? "", bankName: company?.bankName ?? "" },
    buyer: { id: String(c.number), ...buyer },
    taxMode: inv.taxMode, lines: data.lines.map((l) => ({ position: l.position, name: l.description, sku: l.sku, ean: l.ean, qty: l.qty, unitPriceCents: l.unitPriceCents, netCents: l.netCents, vatRateBp: l.vatRateBp,
      netUnitPrice: inv.pricesGross && l.qty ? (Math.abs(l.netCents) / Math.abs(l.qty) / 100).toFixed(4) : undefined })),
    vatBreakdown: inv.vatBreakdown, netCents: inv.netCents, vatCents: inv.vatCents, grossCents: inv.grossCents,
    paymentTermsText: inv.dueDate ? `Zahlbar bis ${formatDate(inv.dueDate)} ohne Abzug.` : "Sofort fällig.",
  });
  return renderPdf(data, { xml });
}

/** Ausgestellte Rechnungen werden einmalig als PDF archiviert und danach immer unverändert ausgeliefert. */
export async function archivedInvoicePdf(invoiceId: string): Promise<Uint8Array> {
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
  if (!inv) throw new Error("notFound");
  if (inv.status === "DRAFT") return invoicePdf(invoiceId);
  if (inv.pdfFileId) {
    const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, inv.pdfFileId) });
    if (f) return new Uint8Array(f.data);
  }
  const bytes = await invoicePdf(invoiceId);
  const buf = Buffer.from(bytes);
  await db.transaction(async (tx) => {
    const again = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
    if (again?.pdfFileId) return;
    const [file] = await tx.insert(schema.storedFiles).values({
      name: `${inv.number}.pdf`, mime: "application/pdf", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
    }).returning({ id: schema.storedFiles.id });
    await tx.update(schema.invoices).set({ pdfFileId: file.id }).where(eq(schema.invoices.id, invoiceId));
  });
  return bytes;
}

export async function offerPdf(offerId: string) {
  const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, offerId), with: { lines: true, customer: true } });
  if (!o) throw new Error("notFound");
  const { computeTotals } = await import("./tax");
  const t = computeTotals(o.lines.sort((a, b) => a.position - b.position), o.discountBp);
  const c = o.customer;
  const { determineTaxMode } = await import("./tax");
  return renderPdf({
    kind: "offer", number: o.number, date: o.date, deliveryDate: null, dueDate: null, validUntil: o.validUntil,
    customerNo: c.number, customerId: c.id, buyer: { name: c.name, street: c.street, zip: c.zip, city: c.city, country: c.country, vatId: c.vatId },
    lines: (await linesWithProducts(o.lines)).map((l, i) => ({ ...l, netCents: t.lines[i].netCents })),
    subtotalCents: t.subtotalCents, discountCents: t.discountCents, discountBp: o.discountBp, netCents: t.netCents, vatCents: t.vatCents,
    grossCents: t.grossCents, vatBreakdown: t.vatByRate, taxMode: determineTaxMode(c), ossCountry: null,
    skontoBp: 0, skontoDays: 0, retentionOfTitle: false, notes: o.notes, refNumber: null,
  });
}

// ───────────────────────── Briefe: Quittung, Mahnung ─────────────────────────

type Letter = {
  title: string; buyer: Party; info: [string, string][]; paragraphs: string[];
  table?: { head: string[]; rows: string[][]; widths: number[] }; total?: [string, string]; afterTable?: string[]; signature?: boolean;
};

async function companyAndLogo(doc: PDFDocument) {
  const company = (await db.query.companySettings.findFirst()) as typeof schema.companySettings.$inferSelect;
  let logo = null;
  if (company?.logoFileId) {
    const file = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, company.logoFileId) });
    if (file?.mime === "image/png") logo = await doc.embedPng(file.data);
    else if (file?.mime === "image/jpeg") logo = await doc.embedJpg(file.data);
  }
  return { company, logo };
}

export async function renderLetter(l: Letter): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(l.title); doc.setLanguage("de-DE"); doc.setCreator("Star Style");
  const f = await fonts(doc);
  const { company, logo } = await companyAndLogo(doc);
  const w = new Writer(doc, f, company, logo);
  w.newPage();
  const sender = [company.name, company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  w.text(sender, 20 * MM, H - 47 * MM, 7, f.r, SOFT);
  w.page.drawLine({ start: { x: 20 * MM, y: H - 48 * MM }, end: { x: 105 * MM, y: H - 48 * MM }, thickness: 0.4, color: LINE });
  [l.buyer.name, l.buyer.street, [l.buyer.zip, l.buyer.city].filter(Boolean).join(" "), countryName(l.buyer.country)].filter(Boolean)
    .forEach((s, i) => w.text(s, 20 * MM, H - 54 * MM - i * 4.6 * MM, 10, i === 0 ? f.s : f.r));
  l.info.forEach(([k, v], i) => { w.text(k, 125 * MM, H - 50 * MM - i * 4.8 * MM, 8.5, f.r, SOFT); w.right(v, W - 20 * MM, H - 50 * MM - i * 4.8 * MM, 8.5, f.s); });
  w.y = H - 100 * MM;
  w.text(l.title, 20 * MM, w.y, 17, f.b); w.y -= 9 * MM;
  const para = (s: string, size = 9.5) => { for (const r of wrap(s, f.r, size, W - 40 * MM)) { w.ensure(6 * MM); w.text(r, 20 * MM, w.y, size); w.y -= 4.8 * MM; } w.y -= 2.5 * MM; };
  l.paragraphs.forEach((p) => para(p));
  if (l.table) {
    const { head, rows, widths } = l.table;
    const xs: number[] = []; let x = 20 * MM; for (const wd of widths) { x += wd * MM; xs.push(x); }
    const drawHead = () => {
      w.page.drawRectangle({ x: 20 * MM, y: w.y - 2.2 * MM, width: W - 40 * MM, height: 7 * MM, color: BRAND });
      head.forEach((h, i) => (i === 0 ? w.text(h, 21.5 * MM, w.y, 8, f.s, rgb(1, 1, 1)) : w.right(h, xs[i] - 1.5 * MM, w.y, 8, f.s, rgb(1, 1, 1))));
      w.y -= 7.5 * MM;
    };
    w.y -= 2 * MM; drawHead();
    rows.forEach((r, ri) => {
      w.ensure(6 * MM, drawHead);
      if (ri % 2 === 1) w.page.drawRectangle({ x: 20 * MM, y: w.y - 2 * MM, width: W - 40 * MM, height: 6 * MM, color: ZEBRA });
      r.forEach((cell, i) => (i === 0 ? w.text(cell, 21.5 * MM, w.y, 9) : w.right(cell, xs[i] - 1.5 * MM, w.y, 9)));
      w.y -= 6 * MM;
    });
  }
  if (l.total) {
    w.ensure(14 * MM); w.y -= 3 * MM;
    w.page.drawRectangle({ x: 112 * MM, y: w.y - 3 * MM, width: W - 20 * MM - 112 * MM, height: 9 * MM, color: BRAND });
    w.text(l.total[0], 115 * MM, w.y, 10.5, f.b, rgb(1, 1, 1)); w.right(l.total[1], W - 21.5 * MM, w.y, 10.5, f.b, rgb(1, 1, 1));
    w.y -= 13 * MM;
  }
  (l.afterTable ?? []).forEach((p) => para(p, 9));
  w.ensure(28 * MM); w.y -= 2 * MM;
  w.text("Mit freundlichen Grüßen", 20 * MM, w.y, 9.5); w.y -= 5 * MM;
  w.text(company.name, 20 * MM, w.y, 9.5, f.s);
  if (l.signature) {
    w.y -= 16 * MM;
    w.page.drawLine({ start: { x: 20 * MM, y: w.y }, end: { x: 90 * MM, y: w.y }, thickness: 0.6, color: INK });
    w.text("Unterschrift Empfänger der Zahlung", 20 * MM, w.y - 4 * MM, 7.5, f.r, SOFT);
  }
  w.footer();
  return doc.save();
}

const invBuyer = (inv: typeof schema.invoices.$inferSelect): Party => ({ name: inv.custName, street: inv.custStreet, zip: inv.custZip, city: inv.custCity, country: inv.custCountry, vatId: inv.custVatId });

export async function receiptPdf(paymentId: string) {
  const p = await db.query.payments.findFirst({ where: eq(schema.payments.id, paymentId), with: { invoice: { with: { customer: true, payments: true } } } });
  if (!p) throw new Error("notFound");
  const inv = p.invoice;
  const before = inv.payments.filter((x) => !x.cancelledAt && x.id !== p.id && (x.date < p.date || (x.date === p.date && x.number < p.number))).reduce((s, x) => s + x.amountCents + x.skontoCents, 0);
  const rest = inv.grossCents - before - p.amountCents - p.skontoCents;
  return renderLetter({
    title: p.cancelledAt ? `Quittung ${p.number} – STORNIERT` : `Quittung ${p.number}`,
    buyer: invBuyer(inv),
    info: [["Quittungsnr.", p.number], ["Datum", formatDate(p.date)], ["Zu Rechnung", inv.number ?? ""], ["Kundennr.", String(inv.customer.number)]],
    paragraphs: [`Wir bestätigen den Eingang von ${formatCents(p.amountCents)} (${METHOD_DE[p.method] ?? p.method}) am ${formatDate(p.date)} für die Rechnung ${inv.number} vom ${formatDate(inv.issueDate)}.`,
      ...(p.note ? [p.note] : []), ...(p.cancelledAt ? [`Diese Zahlung wurde am ${formatDate(p.cancelledAt.toISOString().slice(0, 10))} storniert. Grund: ${p.cancelReason}`] : [])],
    table: { head: ["", "Betrag"], widths: [120, 50], rows: [["Rechnungsbetrag", formatCents(inv.grossCents)], ["Bereits vorher bezahlt", formatCents(before)], ["Diese Zahlung", formatCents(p.amountCents)],
      ...(p.skontoCents ? [["Abzüglich Skonto", formatCents(p.skontoCents)]] : [])] },
    total: [rest > 0 ? "Noch offen" : rest < 0 ? "Guthaben" : "Vollständig bezahlt", formatCents(Math.abs(rest))],
    signature: p.method === "CASH",
  });
}

export async function dunningPdf(dunningId: string) {
  const d = await db.query.dunnings.findFirst({ where: eq(schema.dunnings.id, dunningId), with: { invoice: { with: { customer: true } } } });
  if (!d) throw new Error("notFound");
  const inv = d.invoice;
  const { DUNNING_LEVELS } = await import("./payments");
  const cfg = DUNNING_LEVELS[d.level - 1];
  const intro = d.level === 1
    ? "sicher haben Sie es im Tagesgeschäft übersehen: Für die folgende Rechnung konnten wir bis heute keinen vollständigen Zahlungseingang feststellen."
    : d.level === 2 ? "leider ist der unten genannte Betrag trotz unserer Zahlungserinnerung noch offen."
    : "trotz unserer bisherigen Schreiben ist der folgende Betrag weiterhin offen. Wir bitten Sie dringend um Ausgleich.";
  const rows = [[`Rechnung ${inv.number} vom ${formatDate(inv.issueDate)} – fälliger, unbezahlter Betrag`, formatCents(d.openCents)]];
  if (d.feeCents) rows.push(["Mahngebühr", formatCents(d.feeCents)]);
  return renderLetter({
    title: cfg.title, buyer: invBuyer(inv),
    info: [["Datum", formatDate(d.date)], ["Rechnungsnr.", inv.number ?? ""], ["Kundennr.", String(inv.customer.number)], ["Zahlbar bis", formatDate(d.newDueDate)]],
    paragraphs: ["Sehr geehrte Damen und Herren,", intro],
    table: { head: ["Position", "Betrag"], widths: [120, 50], rows },
    total: ["Zu zahlen", formatCents(d.openCents + d.feeCents)],
    afterTable: [`Bitte überweisen Sie den Betrag bis zum ${formatDate(d.newDueDate)} unter Angabe der Rechnungsnummer ${inv.number}.`,
      "Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos."],
  });
}

// ───────────────────────── Bericht (Monatsübersicht) ─────────────────────────

type ReportSection = { heading: string; head: string[]; widths: number[]; rows: string[][]; total?: [string, string]; note?: string };

export async function renderReport(r: { title: string; subtitle: string; sections: ReportSection[]; notes: string[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(r.title); doc.setLanguage("de-DE"); doc.setCreator("Star Style");
  const f = await fonts(doc);
  const { company, logo } = await companyAndLogo(doc);
  const w = new Writer(doc, f, company ?? ({ name: "" } as typeof schema.companySettings.$inferSelect), logo);
  w.newPage();
  w.y = H - 40 * MM;
  w.text(r.title, 20 * MM, w.y, 17, f.b); w.y -= 6 * MM;
  w.text(r.subtitle, 20 * MM, w.y, 9, f.r, SOFT); w.y -= 10 * MM;
  for (const s of r.sections) {
    w.ensure(30 * MM);
    w.text(s.heading, 20 * MM, w.y, 11, f.b, BRAND); w.y -= 6 * MM;
    const xs: number[] = []; let x = 20 * MM; for (const wd of s.widths) { x += wd * MM; xs.push(x); }
    const head = () => {
      w.page.drawRectangle({ x: 20 * MM, y: w.y - 2.2 * MM, width: W - 40 * MM, height: 6.5 * MM, color: BRAND });
      s.head.forEach((h, i) => (i === 0 ? w.text(h, 21.5 * MM, w.y, 7.5, f.s, rgb(1, 1, 1)) : w.right(h, xs[i] - 1.5 * MM, w.y, 7.5, f.s, rgb(1, 1, 1))));
      w.y -= 7 * MM;
    };
    head();
    if (!s.rows.length) { w.text("–", 21.5 * MM, w.y, 8.5, f.r, SOFT); w.y -= 5.5 * MM; }
    s.rows.forEach((row, ri) => {
      w.ensure(6 * MM, head);
      if (ri % 2 === 1) w.page.drawRectangle({ x: 20 * MM, y: w.y - 1.8 * MM, width: W - 40 * MM, height: 5.5 * MM, color: ZEBRA });
      row.forEach((cell, i) => (i === 0 ? w.text(cell, 21.5 * MM, w.y, 8.5) : w.right(cell, xs[i] - 1.5 * MM, w.y, 8.5)));
      w.y -= 5.5 * MM;
    });
    if (s.total) {
      w.y -= 1.5 * MM;
      w.page.drawRectangle({ x: 100 * MM, y: w.y - 2.5 * MM, width: W - 20 * MM - 100 * MM, height: 7.5 * MM, color: BRAND });
      w.text(s.total[0], 102.5 * MM, w.y, 9, f.b, rgb(1, 1, 1)); w.right(s.total[1], W - 21.5 * MM, w.y, 9, f.b, rgb(1, 1, 1));
      w.y -= 8 * MM;
    }
    if (s.note) { w.text(s.note, 20 * MM, w.y, 7.5, f.r, SOFT); w.y -= 5 * MM; }
    w.y -= 5 * MM;
  }
  for (const n of r.notes) for (const line of wrap(n, f.r, 7.5, W - 40 * MM)) { w.ensure(5 * MM); w.text(line, 20 * MM, w.y, 7.5, f.r, SOFT); w.y -= 3.8 * MM; }
  w.footer();
  return doc.save();
}
