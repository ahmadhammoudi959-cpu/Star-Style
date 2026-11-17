"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { can, requirePerm } from "@/lib/auth";
import { ImportError, runImport } from "@/lib/product-import-db";
import { mappingFromParams } from "@/lib/product-import";
import { validTempId } from "@/lib/temp-files";

export type ImportState = { error?: string } | undefined;

/**
 * Artikel aus der geprüften Excel/CSV-Datei anlegen. Der Server liest die Datei selbst noch einmal und prüft alles neu
 * (nichts aus dem Browser wird übernommen außer der Spalten-Zuordnung und den Häkchen).
 */
export async function importProductsAction(_: ImportState, fd: FormData): Promise<ImportState> {
  const s = await requirePerm("products.edit");
  const fileId = String(fd.get("file") ?? "");
  if (!validTempId(fileId)) return { error: "fileGone" };
  const photoIds = String(fd.get("photos") ?? "").split(",").filter((x) => validTempId(x));
  const head = Number(fd.get("head"));
  let res;
  try {
    res = await runImport(s.uid, {
      fileId, photoIds, sheet: String(fd.get("sheet") ?? "") || null, headerRow: Number.isInteger(head) && head >= 1 ? head - 1 : null,
      mapping: mappingFromParams((k) => fd.get(k) as string | null), gross: fd.get("gross") === "1",
      general: fd.get("general") === "on", brand: fd.get("brand") === "on",
    }, { prices: can(s, "products.prices"), cost: can(s, "products.cost"), stock: can(s, "stock.receive") });
  } catch (e) {
    if (e instanceof ImportError) return { error: e.code };
    console.error("product import", e);
    return { error: "failed" };
  }
  revalidatePath("/products");
  revalidatePath("/stock");
  revalidatePath("/shops", "layout");
  redirect(`/products/import?done=${[res.created, res.variants, res.photos, res.skipped, res.stock].join(".")}`);
}
