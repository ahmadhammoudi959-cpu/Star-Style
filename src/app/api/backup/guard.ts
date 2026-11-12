import { getAuth, type Authed } from "@/lib/auth";

/** Nur Admin, nicht mit Einmal-Passwort; POST nur von unserer eigenen Seite (gegen fremde Seiten, die das Cookie mitschicken) */
export async function backupAdmin(req: Request, post = false): Promise<Authed | Response> {
  const a = await getAuth();
  if (!a) return new Response("Unauthorized", { status: 401 });
  if (!a.admin || a.mustChange) return new Response("Forbidden", { status: 403 });
  if (post) {
    const site = req.headers.get("sec-fetch-site");
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const same = site ? site === "same-origin" : !!origin && !!host && new URL(origin).host === host;
    if (!same) return new Response("Forbidden", { status: 403 });
  }
  return a;
}
