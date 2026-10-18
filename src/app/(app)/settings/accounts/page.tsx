import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { ACCOUNT_DEFS, type AccountKey, type Chart } from "@/lib/accounts";
import { AccountsForm } from "./AccountsForm";

export default async function AccountsPage() {
  const { t } = await getI18n();
  const s = await db.query.companySettings.findFirst();
  const chart = (s?.chartOfAccounts ?? "SKR03") as Chart;
  const rows = (Object.keys(ACCOUNT_DEFS) as AccountKey[]).map((k) => ({ key: k, label: ACCOUNT_DEFS[k].label, standard: ACCOUNT_DEFS[k][chart], value: s?.accountOverrides?.[k] ?? null }));
  return (
    <div>
      <PageHeader title={t.settings.accounts} subtitle={`${chart} · ${t.settings.accountsHint}`} back="/settings#datev" />
      <AccountsForm t={t} rows={rows} />
    </div>
  );
}
