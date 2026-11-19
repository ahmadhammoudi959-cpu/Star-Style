import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { ProductForm } from "../ProductForm";
import { formLookups } from "../helpers";
import { productShopStatus } from "@/lib/shopify/product-push";
import { can, requirePerm } from "@/lib/auth";
import { manualPrefill } from "@/lib/direct";

export default async function NewProduct({ searchParams }: { searchParams: Promise<{ barcode?: string; category?: string; direct?: string }> }) {
  const { barcode = "", category = "", direct = "" } = await searchParams;
  const session = await requirePerm("products.edit");
  const rights = { edit: true, prices: can(session, "products.prices"), cost: can(session, "products.cost"), receive: can(session, "stock.receive") };
  const { t } = await getI18n();
  // vom Scanner: unbekannter Barcode → gleich eingetragen (Art.-Nr. folgt ihm automatisch)
  const code = barcode.replace(/\s+/g, "").slice(0, 32);
  const [{ suppliers, categories }, shopStatus] = await Promise.all([formLookups(), productShopStatus()]);
  // von der Seite „Kategorien“: neuer Artikel gleich in dieser Kategorie (nur bekannte Namen)
  const cat = categories.find((c) => c.toLowerCase() === category.trim().toLowerCase()) ?? "";
  // von einer Liste vom Bestell-Link: Artikel von Hand → Name, Preis (Preisgruppe des Links), Größe/Farbe und Foto vorbelegt
  const m = direct && can(session, "direct") ? await manualPrefill(direct.slice(0, 64)) : null;
  const price = m && m.priceCents > 0 ? (m.priceCents / 100).toFixed(2).replace(".", ",") : "";
  const variant = code || m?.size || m?.color
    ? [{ size: m?.size ?? "", color: m?.color ?? "", barcode: code, minStock: 0, weight: "", weightUnit: "g" as const, pkgL: "", pkgW: "", pkgH: "" }] : [];
  return (
    <div>
      <PageHeader title={t.product.new} back={m ? `/direct/${m.orderId}` : "/products"} subtitle={m ? t.product.fromManual : undefined} />
      <ProductForm t={t} suppliers={suppliers} categories={categories} shopStatus={shopStatus} rights={rights} initial={{
        sku: "", nameDe: m?.name ?? "", nameNl: "", descriptionDe: "", descriptionNl: "", category: cat, supplierId: "", vatRateBp: 1900,
        purchasePrice: "", wholesalePrice: m?.priceGroup === "WHOLESALE" ? price : "", retailPrice: m?.priceGroup === "RETAIL" ? price : "",
        tracksExpiry: false, inBrandShop: false, inGeneralShop: true, shippingClass: "",
        imageFileId: m?.photoFileId ?? null, imageFrom: m?.photoFileId ?? null,
        variants: variant,
      }} />
    </div>
  );
}
