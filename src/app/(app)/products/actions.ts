"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { parseMoney } from "@/lib/money";
import { audit } from "@/lib/stock";

export type ProductFormState = { error?: string; field?: string } | undefined;

const money = z.string().transform((s, ctx) => {
  const v = parseMoney(s === "" ? "0" : s);
  if (v == null || v < 0) { ctx.addIssue({ code: "custom", message: "money" }); return z.NEVER; }
  return v;
});

const VariantSchema = z.object({
  id: z.string().optional(),
  size: z.string().trim().max(60).default(""),
  color: z.string().trim().max(60).default(""),
  barcode: z.string().trim().max(32).default(""),
  minStock: z.coerce.number().int().min(0).default(0),
});

const ProductSchema = z.object({
  id: z.string().optional(),
  sku: z.string().trim().min(1).max(64),
  nameDe: z.string().trim().min(1).max(200),
  nameNl: z.string().trim().max(200).default(""),
  descriptionDe: z.string().trim().max(4000).default(""),
  descriptionNl: z.string().trim().max(4000).default(""),
  category: z.string().trim().max(100).default(""),
  supplierId: z.string().default(""),
  vatRateBp: z.coerce.number().refine((n) => n === 1900 || n === 700),
  purchasePrice: money,
  wholesalePrice: money,
  retailPrice: money,
  tracksExpiry: z.string().optional().transform((v) => v === "on"),
  inBrandShop: z.string().optional().transform((v) => v === "on"),
  inGeneralShop: z.string().optional().transform((v) => v === "on"),
  variants: z.string().transform((s) => JSON.parse(s)).pipe(z.array(VariantSchema).min(1)),
});

export async function saveProduct(_: ProductFormState, fd: FormData): Promise<ProductFormState> {
  const session = await requireSession();
  const parsed = ProductSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: "required", field: String(issue.path[0] ?? "") };
  }
  const d = parsed.data;
  const keys = new Set<string>();
  for (const v of d.variants) {
    const k = `${v.size.toLowerCase()}|${v.color.toLowerCase()}`;
    if (keys.has(k)) return { error: "duplicateVariant" };
    keys.add(k);
  }
  const barcodes = d.variants.map((v) => v.barcode).filter(Boolean);
  if (new Set(barcodes).size !== barcodes.length) return { error: "barcodeTaken" };

  const values = {
    sku: d.sku, nameDe: d.nameDe, nameNl: d.nameNl, descriptionDe: d.descriptionDe, descriptionNl: d.descriptionNl,
    category: d.category, supplierId: d.supplierId || null, vatRateBp: d.vatRateBp,
    purchasePriceCents: d.purchasePrice, wholesalePriceCents: d.wholesalePrice, retailPriceCents: d.retailPrice,
    tracksExpiry: d.tracksExpiry, inBrandShop: d.inBrandShop, inGeneralShop: d.inGeneralShop,
  };

  let productId = d.id;
  try {
    await db.transaction(async (tx) => {
      // Eindeutigkeit vorab prüfen → verständliche Fehlermeldung
      const skuOwner = await tx.query.products.findFirst({ where: eq(schema.products.sku, d.sku) });
      if (skuOwner && skuOwner.id !== d.id) throw new Error("skuTaken");
      if (barcodes.length) {
        const taken = await tx.select({ productId: schema.variants.productId }).from(schema.variants)
          .where(inArray(schema.variants.barcode, barcodes));
        if (taken.some((t) => t.productId !== d.id)) throw new Error("barcodeTaken");
      }

      if (d.id) {
        const before = await tx.query.products.findFirst({ where: eq(schema.products.id, d.id) });
        if (!before) throw new Error("notFound");
        await tx.update(schema.products).set(values).where(eq(schema.products.id, d.id));
        await audit(tx, { entity: "product", entityId: d.id, action: "update", before, after: values, userId: session.uid });
      } else {
        const [p] = await tx.insert(schema.products).values(values).returning({ id: schema.products.id });
        productId = p.id;
        await audit(tx, { entity: "product", entityId: p.id, action: "create", after: values, userId: session.uid });
      }

      // Varianten: bestehende aktualisieren, neue anlegen, entfernte deaktivieren (Historie bleibt erhalten)
      // Barcodes dieses Artikels zuerst leeren, damit Tausch zwischen Varianten möglich ist
      await tx.update(schema.variants).set({ barcode: null }).where(eq(schema.variants.productId, productId!));
      for (const v of d.variants) {
        const vals = { size: v.size, color: v.color, barcode: v.barcode || null, minStock: v.minStock, active: true };
        if (v.id) await tx.update(schema.variants).set(vals).where(and(eq(schema.variants.id, v.id), eq(schema.variants.productId, productId!)));
        else {
          // evtl. früher deaktivierte Variante mit gleicher Größe/Farbe reaktivieren
          const existing = await tx.query.variants.findFirst({
            where: and(eq(schema.variants.productId, productId!), eq(schema.variants.size, v.size), eq(schema.variants.color, v.color)),
          });
          if (existing) await tx.update(schema.variants).set(vals).where(eq(schema.variants.id, existing.id));
          else await tx.insert(schema.variants).values({ productId: productId!, ...vals });
        }
      }
      const activeIds = (await tx.select({ id: schema.variants.id }).from(schema.variants)
        .where(and(eq(schema.variants.productId, productId!), eq(schema.variants.active, true)))).map((r) => r.id);
      const wanted = new Set<string>();
      for (const v of d.variants) {
        const row = await tx.query.variants.findFirst({
          where: and(eq(schema.variants.productId, productId!), eq(schema.variants.size, v.size), eq(schema.variants.color, v.color)),
        });
        if (row) wanted.add(row.id);
      }
      const drop = activeIds.filter((id) => !wanted.has(id));
      if (drop.length) {
        const withStock = await tx.select({ id: schema.variants.id }).from(schema.variants)
          .where(and(inArray(schema.variants.id, drop), ne(schema.variants.stockQty, 0)));
        if (withStock.length) throw new Error("variantHasStock");
        await tx.update(schema.variants).set({ active: false, barcode: null }).where(inArray(schema.variants.id, drop));
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "skuTaken" || msg === "barcodeTaken" || msg === "variantHasStock") return { error: msg };
    if (/variants_barcode_unique|barcode/.test(msg)) return { error: "barcodeTaken" };
    if (/products_sku_unique/.test(msg)) return { error: "skuTaken" };
    console.error(e);
    return { error: "error" };
  }
  revalidatePath("/products");
  revalidatePath("/stock");
  redirect(`/products/${productId}?saved=1`);
}

export async function setProductActive(id: string, active: boolean) {
  const session = await requireSession();
  await db.transaction(async (tx) => {
    await tx.update(schema.products).set({ active }).where(eq(schema.products.id, id));
    await audit(tx, { entity: "product", entityId: id, action: active ? "activate" : "deactivate", userId: session.uid });
  });
  revalidatePath("/products");
}

