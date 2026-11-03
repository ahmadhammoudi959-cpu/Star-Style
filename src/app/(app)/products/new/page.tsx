import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { ProductForm } from "../ProductForm";
import { formLookups } from "../helpers";
import { productShopStatus } from "@/lib/shopify/product-push";

export default async function NewProduct() {
  const { t } = await getI18n();
  const [{ suppliers, categories }, shopStatus] = await Promise.all([formLookups(), productShopStatus()]);
  return (
    <div>
      <PageHeader title={t.product.new} back="/products" />
      <ProductForm t={t} suppliers={suppliers} categories={categories} shopStatus={shopStatus} initial={{
        sku: "", nameDe: "", nameNl: "", descriptionDe: "", descriptionNl: "", category: "", supplierId: "", vatRateBp: 1900,
        purchasePrice: "", wholesalePrice: "", retailPrice: "", tracksExpiry: false, inBrandShop: false, inGeneralShop: true, variants: [],
      }} />
    </div>
  );
}
