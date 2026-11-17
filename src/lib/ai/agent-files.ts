import "server-only";
/**
 * Abgelegte Dateien für den Assistenten lesbar machen (Wunsch Inhaber 17.11.2026: „يقرا الفايل ويترجمه للاتجاه الصح“):
 * Tabellen als Zeilen-Text („R3: Haarwachs | 4006381333931 | 12,50 [Foto]“), PDFs und Fotos direkt für die KI.
 */
import sharp from "sharp";
import { loadTempFile, type TempMeta } from "../temp-files";
import { readWorkbook, type Workbook } from "../sheet-read";
import type { ContentBlock } from "./client";

export const FILE_LIMITS = { rowsShown: 150, chars: 30_000, cell: 80, pdfBytes: 10 * 1024 * 1024, imagePx: 1568, readRows: 300 };

/** Tabelle → Text mit echten Zeilennummern; Fotos je Zeile markiert; höchstens `maxRows` Zeilen / `chars` Zeichen */
export function sheetText(wb: Workbook, o: { sheet?: string; from?: number; to?: number; maxRows?: number; chars?: number } = {}): string {
  const out: string[] = [];
  let budget = o.chars ?? FILE_LIMITS.chars;
  for (const s of wb.sheets) {
    if (o.sheet && s.name !== o.sheet) continue;
    const photoRows = new Set(s.images.map((i) => i.row));
    const filled = s.rows.map((r, i) => ({ r, i })).filter((x) => x.r.some((c) => c));
    const cols = Math.max(0, ...s.rows.map((r) => r.length));
    const from = Math.max(1, o.from ?? 1), to = o.to ?? Number.MAX_SAFE_INTEGER;
    const pick = filled.filter((x) => x.i + 1 >= from && x.i + 1 <= to);
    const rows = pick.slice(0, o.maxRows ?? FILE_LIMITS.rowsShown);
    const head = `SHEET "${s.name}": ${filled.length} filled rows, ${cols} columns${s.images.length ? `, ${s.images.length} photos (in rows ${[...photoRows].map((r) => r + 1).slice(0, 40).join(",")}${photoRows.size > 40 ? ",…" : ""})` : ""}`;
    out.push(head); budget -= head.length;
    let shown = 0;
    for (const { r, i } of rows) {
      const line = `R${i + 1}: ${r.map((c) => (c.length > FILE_LIMITS.cell ? c.slice(0, FILE_LIMITS.cell) + "…" : c)).join(" | ")}${photoRows.has(i) ? " [photo]" : ""}`;
      if (budget - line.length < 0) break;
      out.push(line); budget -= line.length + 1; shown++;
    }
    if (shown < pick.length) out.push(`… ${pick.length - shown} more rows not shown – use read_file with from/to to see them`);
    if (budget <= 0) break;
  }
  return out.join("\n");
}

const label = (m: TempMeta, what: string) => `ATTACHED FILE "${m.name}" (${what}, file id ${m.id})`;

/** Inhalte der abgelegten Dateien als Bausteine für die Nachricht an die KI (nur eigene Dateien der Person) */
export async function fileBlocks(uid: string, ids: string[]): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const id of ids.slice(0, 10)) {
    const f = await loadTempFile(uid, id);
    if (!f) { out.push({ type: "text", text: `FILE ${id} is no longer available – ask the user to attach it again.` }); continue; }
    const { meta, buf } = f;
    try {
      if (meta.kind === "sheet") {
        const wb = await readWorkbook(buf, meta.name);
        out.push({ type: "text", text: `${label(meta, "spreadsheet")}\n${sheetText(wb)}` });
      } else if (meta.kind === "pdf") {
        if (buf.length > FILE_LIMITS.pdfBytes) out.push({ type: "text", text: `${label(meta, "PDF")}: too large for you to read (${Math.round(buf.length / 1048576)} MB) – it can still be attached to a file field.` });
        else out.push({ type: "text", text: label(meta, "PDF") }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } });
      } else {
        const jpg = await sharp(buf, { animated: false }).rotate()
          .resize(FILE_LIMITS.imagePx, FILE_LIMITS.imagePx, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
        out.push({ type: "text", text: label(meta, "photo") }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
      }
    } catch {
      out.push({ type: "text", text: `${label(meta, meta.kind)}: could not be read (damaged or unsupported).` });
    }
  }
  return out;
}

/** Werkzeug read_file: mehr Zeilen einer abgelegten Tabelle */
export async function readFileTool(uid: string, i: Record<string, unknown>): Promise<string> {
  const f = await loadTempFile(uid, String(i.file ?? ""));
  if (!f) return "File not available (expired or not attached in this conversation).";
  if (f.meta.kind !== "sheet") return `"${f.meta.name}" is a ${f.meta.kind} – its content was shown when it was attached.`;
  const wb = await readWorkbook(f.buf, f.meta.name);
  const from = Math.max(1, Math.round(Number(i.from) || 1));
  const to = Math.min(from + FILE_LIMITS.readRows - 1, Math.round(Number(i.to) || from + FILE_LIMITS.readRows - 1));
  return sheetText(wb, { sheet: typeof i.sheet === "string" && i.sheet ? i.sheet : undefined, from, to, maxRows: FILE_LIMITS.readRows, chars: 40_000 });
}
