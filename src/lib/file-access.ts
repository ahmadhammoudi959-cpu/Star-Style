import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Perm } from "./permissions";

/**
 * Wer darf eine gespeicherte Datei öffnen? Hängt davon ab, wozu sie gehört (Berechtigungen, 12.11.2026):
 * Produkt-/Variantenfotos, Shop-Fotos, das Logo und Werbebilder der Aktionen = alle Angemeldeten; Beleg einer Ausgabe, Rechnungs-PDF, Verlustfoto,
 * Monatsmappe = ihr Bereich (oder die Monatsmappe fürs Steuerbüro), GLS-Etikett = Verkauf/Versand, Foto eines Artikels von Hand
 * (Bestell-Link) = Direktverkauf bzw. im Angebot Verkauf; gehört sie zu nichts mehr = nur Admin.
 */
export async function fileNeed(id: string): Promise<"all" | "admin" | Perm[]> {
  const r = await db.execute<{ pub: boolean; exp: boolean; inv: boolean; wo: boolean; adv: boolean; lbl: boolean; wa: boolean; dir: boolean; ofr: boolean }>(sql`select
    exists(select 1 from products where image_file_id = ${id}) or exists(select 1 from variants where image_file_id = ${id})
      or exists(select 1 from shop_media where file_id = ${id}) or exists(select 1 from company_settings where logo_file_id = ${id})
      or exists(select 1 from promotions p, jsonb_each_text(p.banner_files) f where f.value = ${id}) as pub,
    exists(select 1 from expenses where file_id = ${id}) as exp,
    exists(select 1 from invoices where pdf_file_id = ${id} or export_proof_file_id = ${id}) as inv,
    exists(select 1 from write_offs where photo_file_id = ${id}) as wo,
    exists(select 1 from advisor_exports where file_id = ${id}) as adv,
    exists(select 1 from shipments where label_file_id = ${id}) as lbl,
    exists(select 1 from wa_messages where media_file_id = ${id}) as wa,
    exists(select 1 from direct_order_lines where photo_file_id = ${id}) as dir,
    exists(select 1 from offer_lines where photo_file_id = ${id}) as ofr`);
  const x = r.rows[0];
  if (x?.pub) return "all";
  const need = new Set<Perm>();
  if (x?.exp) { need.add("expenses.view"); need.add("reports.export"); }
  if (x?.inv) { need.add("sales.view"); need.add("reports.export"); }
  if (x?.wo) need.add("stock.writeoff");
  if (x?.adv) need.add("reports.export");
  if (x?.lbl) { need.add("sales.shipping"); need.add("sales.view"); } // GLS-Etikett einer Sendung
  if (x?.wa) need.add("whatsapp"); // Bild/Sprachnachricht/Dokument aus einem WhatsApp-Chat
  if (x?.dir) need.add("direct"); // Foto eines Artikels von Hand aus einer Liste vom Bestell-Link
  if (x?.ofr) need.add("sales.view"); // … und im Angebot daraus
  return need.size ? [...need] : "admin";
}
