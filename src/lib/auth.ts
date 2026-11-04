import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession, type Session } from "./session";
import { sessionCurrent } from "./session-check";

export async function getSession(): Promise<Session | null> {
  const c = await cookies();
  const s = await verifySession(c.get(SESSION_COOKIE)?.value);
  return s && (await sessionCurrent(s.uid, s.sv)) ? s : null;
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}
