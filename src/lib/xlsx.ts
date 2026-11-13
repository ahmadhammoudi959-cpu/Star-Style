/**
 * Kleine Excel-Datei (.xlsx, Office Open XML) mit EINER Tabelle – für Listen zum Herunterladen (Kundenliste mit E-Mails,
 * Wunsch Inhaber 13.11.2026: „أقدر أعمل تصدير للإيميلات في إكسل شيت“). Bewusst .xlsx statt CSV: Arabisch/Umlaute ohne
 * Zeichensatz-Ärger, führende Nullen bleiben (PLZ, Telefon), Texte wie „=1+1“ sind nie Formeln, Datum als echtes Datum.
 * Rein (nur jszip), getestet in tests/xlsx.test.ts.
 */
import JSZip from "jszip";

/** text = Text (nie Formel), int = ganze Zahl, date = JJJJ-MM-TT als Excel-Datum im deutschen Format */
export type XlsxColumn = { header: string; width?: number; kind?: "text" | "int" | "date" };
export type XlsxCell = string | number | null | undefined;
export type XlsxSheet = { name: string; rtl?: boolean; columns: XlsxColumn[]; rows: XlsxCell[][] };

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** XML-Text: Steuerzeichen raus (in XML 1.0 verboten), Sonderzeichen maskiert */
const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
export const xmlText = (s: string) => s.replace(BAD, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Spaltenbuchstaben: 0 → A, 25 → Z, 26 → AA */
export function colName(i: number) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel erlaubt höchstens 31 Zeichen und keines von : \ / ? * [ ] */
export const sheetName = (s: string) => s.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Tabelle1";

/** Excel-Datumszahl (Tage seit 30.12.1899) aus JJJJ-MM-TT – ohne Zeitzone; ungültig → null */
export function excelDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return (t - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const MAX_TEXT = 32_767; // mehr Zeichen passen nicht in eine Excel-Zelle

function cell(ref: string, v: XlsxCell, kind: XlsxColumn["kind"], style?: number): string {
  if (v == null || v === "") return "";
  const s = style ? ` s="${style}"` : "";
  if (kind === "int" && typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${Math.trunc(v)}</v></c>`;
  if (kind === "date" && typeof v === "string") {
    const n = excelDate(v);
    if (n != null) return `<c r="${ref}" s="2"><v>${n}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlText(String(v).slice(0, MAX_TEXT))}</t></is></c>`;
}

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Die Datei: Kopfzeile fett auf Nachtblau, bleibt beim Scrollen stehen, Filter-Pfeile, Spaltenbreiten, Arabisch von rechts */
export async function buildXlsx(sh: XlsxSheet): Promise<Buffer> {
  const name = sheetName(sh.name);
  const cols = sh.columns;
  const last = colName(Math.max(cols.length, 1) - 1);
  const lastRow = sh.rows.length + 1;
  const range = `A1:${last}${lastRow}`;
  const header = `<row r="1">${cols.map((c, i) => cell(`${colName(i)}1`, c.header, "text", 1)).join("")}</row>`;
  const body = sh.rows.map((r, ri) => `<row r="${ri + 2}">${cols.map((c, i) => cell(`${colName(i)}${ri + 2}`, r[i], c.kind)).join("")}</row>`).join("");
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(c.width ?? 14, 4), 80)}" customWidth="1"/>`).join("");
  const sheet = `${HEAD}<worksheet ${NS}><dimension ref="${range}"/>`
    + `<sheetViews><sheetView${sh.rtl ? ` rightToLeft="1"` : ""} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    + `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${header}${body}</sheetData>`
    + `<autoFilter ref="${range}"/></worksheet>`;
  const quoted = `'${name.replace(/'/g, "''")}'`;
  const workbook = `${HEAD}<workbook ${NS}><bookViews><workbookView/></bookViews>`
    + `<sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets>`
    + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xmlText(`${quoted}!$A$1:$${last}$${lastRow}`)}</definedName></definedNames></workbook>`;
  const styles = `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>`
    + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>`
    + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FF0B1222"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`
    + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const zip = new JSZip();
  const add = (path: string, xml: string) => zip.file(path, xml, { createFolders: false });
  add("[Content_Types].xml", `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  add("_rels/.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add("xl/workbook.xml", workbook);
  add("xl/_rels/workbook.xml.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  add("xl/worksheets/sheet1.xml", sheet);
  add("xl/styles.xml", styles);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
