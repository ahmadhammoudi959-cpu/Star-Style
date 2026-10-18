import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { aiConfigured } from "@/lib/ai/client";
import { Chat } from "./Chat";

export default async function AskPage() {
  const { t } = await getI18n();
  return (
    <div>
      <PageHeader title={t.ai.askTitle} subtitle={t.ai.askHint} />
      {aiConfigured() ? <Chat t={t} /> : (
        <div className="card flex animate-rise items-start gap-3 p-6 text-sm text-ink-soft"><Icon name="lock" className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />{t.ai.notConfigured}</div>
      )}
    </div>
  );
}
