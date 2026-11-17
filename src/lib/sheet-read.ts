/**
 * Tabellen aus Excel (.xlsx) und CSV lesen – für den Assistenten und den Artikel-Import (Wunsch Inhaber 17.11.2026:
 * „يرمي ملف إكسل في الشات … والباركود موجود بالملف … والصور“). Rein (nur jszip), getestet in tests/sheet-read.test.ts.
 * Zellen kommen als Text (Zahlen ohne Exponent – Barcodes bleiben ganz, Datum als JJJJ-MM-TT), dazu eingebettete Bilder
 * mit ihrer Zeile: frei über den Zellen liegende Bilder (Einfügen → Bild) und Bilder IN der Zelle (Excel 365 „In Zelle platzieren“).
 */
import JSZip from "jszip";

export type SheetImage = { row: number; col: number; mime: string; data: Uint8Array; name: string };
/** rows[i] = Zeile i+1 des Blatts (leere Zeilen bleiben als [] stehen, damit Bilder ihre Zeile behalten) */
export type Sheet = { name: string; rows: string[][]; images: SheetImage[] };
export type Workbook = { sheets: Sheet[] };
export class SheetError extends Error {
  constructor(public code: "fileType" | "fileXls" | "empty") { super(code); }
}

export const SHEET_LIMITS = { sheets: 20, rows: 5000, cols: 100, images: 600, imageBytes: 10 * 1024 * 1024, cell: 2000 };

export function sheetKind(buf: Uint8Array, name: string): "xlsx" | "csv" | "xls" | null {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "xlsx";
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "xls";
  if (/\.(csv|tsv|txt)$/i.test(name)) return "csv";
  return null;
}

export async function readWorkbook(buf: Uint8Array, name: string): Promise<Workbook> {
  const kind = sheetKind(buf, name);
  if (kind === "xls") throw new SheetError("fileXls");
  if (kind === "csv") {
    const rows = parseCsv(decodeText(buf));
    if (!rows.some((r) => r.some((c) => c))) throw new SheetError("empty");
    return { sheets: [{ name: name.replace(/\.[^.]+$/, "") || "CSV", rows, images: [] }] };
  }
  if (kind !== "xlsx") throw new SheetError("fileType");
  return readXlsx(buf);
}

// ───────────── CSV ─────────────

/** UTF-8 (mit/ohne BOM), UTF-16 (Excel „Unicode-Text“), sonst Windows-1252 (Excel unter Windows) */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { return new TextDecoder("windows-1252").decode(body); }
}

/** CSV nach RFC 4180 (Anführungszeichen, "" im Feld, Zeilenumbruch im Feld); Trennzeichen ; , Tab oder | wird erkannt */
export function parseCsv(text: string): string[][] {
  const sample = text.slice(0, 20_000);
  const count = (d: string) => {
    let n = 0, q = false, lines = 0;
    for (const ch of sample) {
      if (ch === '"') q = !q;
      else if (!q && ch === d) n++;
      else if (!q && ch === "\n" && ++lines >= 20) break;
    }
    return n;
  };
  const delim = [";", ",", "\t", "|"].map((d) => ({ d, n: count(d) })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const pushCell = () => { row.push(cell.length > SHEET_LIMITS.cell ? cell.slice(0, SHEET_LIMITS.cell) : cell); cell = ""; };
  const pushRow = () => { pushCell(); if (row.length > SHEET_LIMITS.cols) row.length = SHEET_LIMITS.cols; rows.push(row.map((c) => c.trim())); row = []; };
  for (let i = 0; i < text.length && rows.length < SHEET_LIMITS.rows; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === delim) pushCell();
    else if (ch === "\n") pushRow();
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) pushRow();
  while (rows.length && !rows[rows.length - 1].some((c) => c)) rows.pop();
  return rows;
}

// ───────────── XML-Helfer (einfach, für die festen OOXML-Strukturen) ─────────────

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? "")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))); // Excel: Steuerzeichen als _x000D_
}
type El = { attrs: string; inner: string };
/** Elemente mit diesem lokalen Namen (beliebiges Präfix), auch leere <x/> */
function elements(xml: string, local: string): El[] {
  const out: El[] = [];
  const re = new RegExp(`<((?:[\\w.-]+:)?${local})(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</\\1>)`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push({ attrs: m[2], inner: m[3] ?? "" });
  return out;
}
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? "") : null;
}
/** Text aller <t>-Elemente (ohne phonetische Hilfen <rPh>) */
function textOf(inner: string): string {
  return elements(inner.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, ""), "t").map((t) => decodeXml(t.inner)).join("");
}
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
function relsPath(path: string): string {
  const i = path.lastIndexOf("/");
  return `${path.slice(0, i)}/_rels/${path.slice(i + 1)}.rels`;
}
async function readRels(zip: JSZip, path: string): Promise<Map<string, { target: string; type: string }>> {
  const xml = await zip.file(relsPath(path))?.async("string");
  const map = new Map<string, { target: string; type: string }>();
  if (!xml) return map;
  for (const r of elements(xml, "Relationship")) {
    const id = attr(r.attrs, "Id"), target = attr(r.attrs, "Target");
    if (id && target && attr(r.attrs, "TargetMode") !== "External") map.set(id, { target: resolvePath(path, target), type: attr(r.attrs, "Type") ?? "" });
  }
  return map;
}

// ───────────── Zahlen und Datum ─────────────

/** Zahl wie angezeigt, ohne Exponent: 4.006381333931E+12 → "4006381333931", 12.500000000000002 → "12.5" */
export function numberText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v.trim();
  if (Number.isInteger(n)) return Math.abs(n) <= Number.MAX_SAFE_INTEGER ? BigInt(n).toString() : v.trim();
  const s = String(Number(n.toPrecision(15)));
  return /e/i.test(s) ? n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "") : s;
}
const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
function isDateFormat(code: string): boolean {
  const c = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dy]/i.test(c) || /m{3,}/i.test(c) || (/m/i.test(c) && /[dy]/i.test(c));
}
/** Excel-Seriennummer → JJJJ-MM-TT */
export function serialToIso(serial: number, date1904 = false): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.round(serial * 86400) * 1000).toISOString().slice(0, 10);
}

// ───────────── XLSX ─────────────

async function readXlsx(buf: Uint8Array): Promise<Workbook> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new SheetError("fileType"); }
  const wbPath = "xl/workbook.xml";
  const wb = await zip.file(wbPath)?.async("string");
  if (!wb) throw new SheetError("fileType");
  const date1904 = /date1904\s*=\s*["'](1|true)["']/i.test(elements(wb, "workbookPr")[0]?.attrs ?? "");
  const wbRels = await readRels(zip, wbPath);

  const shared = elements((await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "", "si").map((si) => textOf(si.inner));

  // Datumsformate je Stil (Index = s-Attribut der Zelle)
  const stylesXml = (await zip.file("xl/styles.xml")?.async("string")) ?? "";
  const custom = new Map<number, string>();
  for (const f of elements(stylesXml, "numFmt")) custom.set(Number(attr(f.attrs, "numFmtId")), attr(f.attrs, "formatCode") ?? "");
  const cellXfs = elements(stylesXml, "cellXfs")[0]?.inner ?? "";
  const dateStyle = elements(cellXfs, "xf").map((xf) => {
    const id = Number(attr(xf.attrs, "numFmtId") ?? 0);
    return DATE_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!));
  });

  const cellImages = await readCellImages(zip);

  const sheets: Sheet[] = [];
  for (const s of elements(wb, "sheet")) {
    if (sheets.length >= SHEET_LIMITS.sheets) break;
    const state = attr(s.attrs, "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const rel = wbRels.get(attr(s.attrs, "id") ?? "");
    if (!rel) continue;
    const xml = await zip.file(rel.target)?.async("string");
    if (!xml) continue;
    const rows: string[][] = [];
    const images: SheetImage[] = [];
    let rowNo = 0;
    for (const r of elements(xml, "row")) {
      rowNo = Number(attr(r.attrs, "r") ?? rowNo + 1);
      if (rowNo > SHEET_LIMITS.rows) break;
      const cells: string[] = [];
      let colNo = -1;
      for (const c of elements(r.inner, "c")) {
        const ref = attr(c.attrs, "r");
        colNo = ref ? colIndex(ref) : colNo + 1;
        if (colNo >= SHEET_LIMITS.cols) continue;
        const t = attr(c.attrs, "t") ?? "n";
        const v = elements(c.inner, "v")[0]?.inner;
        let text = "";
        if (t === "s") text = shared[Number(v)] ?? "";
        else if (t === "inlineStr") text = textOf(elements(c.inner, "is")[0]?.inner ?? "");
        else if (t === "str") text = decodeXml(v ?? "");
        else if (t === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else if (t === "d") text = decodeXml(v ?? "").slice(0, 10);
        else if (t === "e") text = "";
        else if (v != null && v !== "") text = dateStyle[Number(attr(c.attrs, "s") ?? 0)] && Number.isFinite(Number(v)) ? serialToIso(Number(v), date1904) : numberText(decodeXml(v));
        const vm = attr(c.attrs, "vm");
        if (vm && cellImages.has(Number(vm)) && images.length < SHEET_LIMITS.images) images.push({ ...cellImages.get(Number(vm))!, row: rowNo - 1, col: colNo });
        while (cells.length < colNo) cells.push("");
        cells[colNo] = text.length > SHEET_LIMITS.cell ? text.slice(0, SHEET_LIMITS.cell) : text.trim();
      }
      while (rows.length < rowNo - 1) rows.push([]);
      rows[rowNo - 1] = cells;
    }
    while (rows.length && !rows[rows.length - 1].some((c) => c)) rows.pop();
    images.push(...(await readDrawingImages(zip, rel.target)).slice(0, Math.max(0, SHEET_LIMITS.images - images.length)));
    sheets.push({ name: attr(s.attrs, "name") ?? `Sheet${sheets.length + 1}`, rows, images: images.sort((a, b) => a.row - b.row || a.col - b.col) });
  }
  if (!sheets.some((s) => s.rows.some((r) => r.some((c) => c)))) throw new SheetError("empty");
  return { sheets };
}

const MEDIA_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
async function media(zip: JSZip, path: string): Promise<Omit<SheetImage, "row" | "col"> | null> {
  const mime = MEDIA_MIME[path.split(".").pop()?.toLowerCase() ?? ""];
  const f = zip.file(path);
  if (!mime || !f) return null; // EMF/WMF/TIFF: nicht als Artikelfoto brauchbar
  const data = await f.async("uint8array");
  if (!data.length || data.length > SHEET_LIMITS.imageBytes) return null;
  return { mime, data, name: path.split("/").pop() ?? "image" };
}

/** Bilder, die über den Zellen liegen (Zeichnung des Blatts): Zeile/Spalte = linke obere Ecke */
async function readDrawingImages(zip: JSZip, sheetPath: string): Promise<SheetImage[]> {
  const out: SheetImage[] = [];
  for (const rel of (await readRels(zip, sheetPath)).values()) {
    if (!/\/drawing$/.test(rel.type)) continue;
    const xml = await zip.file(rel.target)?.async("string");
    if (!xml) continue;
    const drels = await readRels(zip, rel.target);
    for (const kind of ["twoCellAnchor", "oneCellAnchor"]) {
      for (const a of elements(xml, kind)) {
        const from = elements(a.inner, "from")[0]?.inner ?? "";
        const row = Number(elements(from, "row")[0]?.inner), col = Number(elements(from, "col")[0]?.inner);
        const embed = attr(elements(a.inner, "blip")[0]?.attrs ?? "", "embed");
        const target = embed ? drels.get(embed)?.target : undefined;
        if (!Number.isInteger(row) || !target) continue;
        const m = await media(zip, target);
        if (m) out.push({ ...m, row, col: Number.isInteger(col) ? col : 0 });
        if (out.length >= SHEET_LIMITS.images) return out;
      }
    }
  }
  return out;
}

/**
 * Bilder IN Zellen (Excel 365): Zelle vm="n" → metadata.xml (valueMetadata → futureMetadata XLRICHVALUE) → Rich Value
 * (rdrichvalue.xml, Feld _rvRel:LocalImageIdentifier laut rdrichvaluestructure.xml) → richValueRel.xml → Bilddatei.
 * Ergebnis: vm-Nummer → Bild. Fehlt ein Teil, gibt es einfach keine Bilder.
 */
async function readCellImages(zip: JSZip): Promise<Map<number, Omit<SheetImage, "row" | "col">>> {
  const out = new Map<number, Omit<SheetImage, "row" | "col">>();
  const meta = await zip.file("xl/metadata.xml")?.async("string");
  const rvXml = await zip.file("xl/richData/rdrichvalue.xml")?.async("string");
  const relXml = await zip.file("xl/richData/richValueRel.xml")?.async("string");
  if (!meta || !rvXml || !relXml) return out;
  const types = elements(elements(meta, "metadataTypes")[0]?.inner ?? "", "metadataType").map((t) => attr(t.attrs, "name"));
  const fm = elements(meta, "futureMetadata").find((f) => attr(f.attrs, "name") === "XLRICHVALUE");
  const futureRv = elements(fm?.inner ?? "", "bk").map((bk) => Number(attr(elements(bk.inner, "rvb")[0]?.attrs ?? "", "i")));
  const valueBk = elements(elements(meta, "valueMetadata")[0]?.inner ?? "", "bk").map((bk) => {
    const rc = elements(bk.inner, "rc")[0]?.attrs ?? "";
    return { t: Number(attr(rc, "t")), v: Number(attr(rc, "v")) };
  });
  const structXml = (await zip.file("xl/richData/rdrichvaluestructure.xml")?.async("string")) ?? "";
  const keyPos = elements(structXml, "s").map((s) => elements(s.inner, "k").findIndex((k) => attr(k.attrs, "n") === "_rvRel:LocalImageIdentifier"));
  const rvs = elements(rvXml, "rv").map((rv) => ({ s: Number(attr(rv.attrs, "s") ?? 0), v: elements(rv.inner, "v").map((v) => v.inner) }));
  const relIds = elements(relXml, "rel").map((r) => attr(r.attrs, "id"));
  const rels = await readRels(zip, "xl/richData/richValueRel.xml");
  for (const [i, bk] of valueBk.entries()) {
    if (types[bk.t - 1] !== "XLRICHVALUE") continue;
    const rv = rvs[futureRv[bk.v]];
    const pos = rv ? keyPos[rv.s] ?? 0 : -1;
    const relIndex = rv && pos >= 0 ? Number(rv.v[pos]) : NaN;
    const target = rels.get(relIds[relIndex] ?? "")?.target;
    if (!target) continue;
    const m = await media(zip, target);
    if (m) out.set(i + 1, m); // vm ist 1-basiert
  }
  return out;
}
