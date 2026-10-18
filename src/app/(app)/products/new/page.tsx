import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { ProductForm } from "../ProductForm";
import { formLookups } from "../helpers";

export default async function NewProduct() {
  const { t } = await getI18n();
  const { suppliers, categories } = await formLookups();
  return (
    <div>
      <PageHeader title={t.product.new} back="/products" />
      <ProductForm t={t} suppliers={suppliers} categories={categories} initial={{
        sku: "", nameDe: "", nameNl: "", descriptionDe: "", descriptionNl: "", category: "", supplierId: "", vatRateBp: 1900,
        purchasePrice: "", wholesalePrice: "", retailPrice: "", tracksExpiry: false, inBrandShop: false, inGeneralShop: true, variants: [],
      }} />
    </div>
  );
}
