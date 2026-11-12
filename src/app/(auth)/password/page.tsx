import { redirect } from "next/navigation";
import { getI18n } from "@/i18n";
import { requireAuth } from "@/lib/auth";
import { PasswordForm } from "./PasswordForm";

export const dynamic = "force-dynamic";

/** Pflicht nach dem Einmal-Passwort vom Admin; wer schon ein eigenes hat, ändert es unter „Mein Konto“ */
export default async function FirstPasswordPage() {
  const a = await requireAuth({ allowMustChange: true });
  if (!a.mustChange) redirect("/account");
  const { t } = await getI18n();
  return <PasswordForm t={t} name={a.name} />;
}
