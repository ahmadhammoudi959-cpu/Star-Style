import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export async function formLookups() {
  const suppliers = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers)
    .where(eq(schema.suppliers.active, true)).orderBy(asc(schema.suppliers.name));
  const cats = await db.execute<{ category: string }>(sql`select distinct category from products where category <> '' order by 1`);
  return { suppliers, categories: cats.rows.map((r) => r.category) };
}
