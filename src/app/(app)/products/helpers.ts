import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { categoryNames } from "@/lib/categories";

export async function formLookups() {
  const suppliers = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers)
    .where(eq(schema.suppliers.active, true)).orderBy(asc(schema.suppliers.name));
  // Kategorien aus dem Verzeichnis (Seite „Kategorien“) – auch leere, frisch angelegte
  return { suppliers, categories: await categoryNames() };
}
