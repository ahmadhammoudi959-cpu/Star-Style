import "server-only";
import { and, asc, eq, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { categoryNames } from "@/lib/categories";

/**
 * Auswahl im Artikel-Formular: nur Warenlieferanten (Firmen aus Ausgaben nicht, Wunsch Inhaber 12.11.2026) – plus der
 * Lieferant, der schon am Artikel steht, sonst ginge er beim nächsten Speichern verloren.
 */
export async function formLookups(currentSupplierId?: string | null) {
  const s = schema.suppliers;
  const goods = and(eq(s.active, true), eq(s.kind, "GOODS"));
  const suppliers = await db.select({ id: s.id, name: s.name }).from(s)
    .where(currentSupplierId ? or(goods, eq(s.id, currentSupplierId)) : goods).orderBy(asc(s.name));
  // Kategorien aus dem Verzeichnis (Seite „Kategorien“) – auch leere, frisch angelegte
  return { suppliers, categories: await categoryNames() };
}
