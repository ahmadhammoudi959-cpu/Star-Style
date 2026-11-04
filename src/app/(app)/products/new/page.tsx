import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { ProductForm } from "../ProductForm";
import { formLookups } from "../helpers";
import { productShopStatus } from "@/lib/shopify/product-push";

export default async function NewProduct({ searchParams }: { searchParams: Promise<{ barcode?: string; category?: string }> }) {
  const { barcode = "", category = "" } = await searchParams;
  const { t } = await getI18n();
  // vom Scanner: unbekannter Barcode → gleich eingetragen (Art.-Nr. folgt ihm automatisch)
  const code = barcode.replace(/\s+/g, "").slice(0, 32);
  const [{ suppliers, categories }, shopStatus] = await Promise.all([formLookups(), productShopStatus()]);
  // von der Seite „Kategorien“: neuer Artikel gleich in dieser Kategorie (nur bekannte Namen)
  const cat = categories.find((c) => c.toLowerCase() === category.trim().toLowerCase()) ?? "";
  return (
    <div>
      <PageHeader title={t.product.new} back="/products" />
      <ProductForm t={t} suppliers={suppliers} categories={categories} shopStatus={shopStatus} initial={{
        sku: "", nameDe: "", nameNl: "", descriptionDe: "", descriptionNl: "", category: cat, supplierId: "", vatRateBp: 1900,
        purchasePrice: "", wholesalePrice: "", retailPrice: "", tracksExpiry: false, inBrandShop: false, inGeneralShop: true,
        variants: code ? [{ size: "", color: "", barcode: code, minStock: 0, weight: "", weightUnit: "g" }] : [],
      }} />
    </div>
  );
}
