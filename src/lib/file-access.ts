import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Perm } from "./permissions";

/**
 * Wer darf eine gespeicherte Datei öffnen? Hängt davon ab, wozu sie gehört (Berechtigungen, 12.11.2026):
 * Produkt-/Variantenfotos, Shop-Fotos und das Logo = alle Angemeldeten; Beleg einer Ausgabe, Rechnungs-PDF, Verlustfoto,
 * Monatsmappe = ihr Bereich (oder die Monatsmappe fürs Steuerbüro); gehört sie zu nichts mehr = nur Admin.
 */
export async function fileNeed(id: string): Promise<"all" | "admin" | Perm[]> {
  const r = await db.execute<{ pub: boolean; exp: boolean; inv: boolean; wo: boolean; adv: boolean }>(sql`select
    exists(select 1 from products where image_file_id = ${id}) or exists(select 1 from variants where image_file_id = ${id})
      or exists(select 1 from shop_media where file_id = ${id}) or exists(select 1 from company_settings where logo_file_id = ${id}) as pub,
    exists(select 1 from expenses where file_id = ${id}) as exp,
    exists(select 1 from invoices where pdf_file_id = ${id} or export_proof_file_id = ${id}) as inv,
    exists(select 1 from write_offs where photo_file_id = ${id}) as wo,
    exists(select 1 from advisor_exports where file_id = ${id}) as adv`);
  const x = r.rows[0];
  if (x?.pub) return "all";
  const need = new Set<Perm>();
  if (x?.exp) { need.add("expenses.view"); need.add("reports.export"); }
  if (x?.inv) { need.add("sales.view"); need.add("reports.export"); }
  if (x?.wo) need.add("stock.writeoff");
  if (x?.adv) need.add("reports.export");
  return need.size ? [...need] : "admin";
}
