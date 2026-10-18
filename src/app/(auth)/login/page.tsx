import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from users`)).rows;
  if (n === 0) redirect("/setup");
  const { t } = await getI18n();
  return <LoginForm t={t} />;
}
