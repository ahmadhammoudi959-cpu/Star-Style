import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { loadAccess } from "@/lib/session-check";
import { allowed, routeNeed } from "@/lib/permissions";

/**
 * Türsteher für jede Anfrage:
 * 1. Ohne gültige Sitzung (Signatur + Sitzungs-Version aus der Datenbank, Konto aktiv) nur Anmeldung, Einrichtung, Health und Shop-Webhook.
 *    Mit Sitzung: jede Seite/API nur mit dem passenden Recht (`routeNeed` in permissions.ts, sonst Startseite bzw. 403);
 *    Einmal-Passwort vom Admin → zuerst /password.
 * 2. Jede Seite bekommt eine Content-Security-Policy mit Einmal-Nonce: nur unsere eigenen Skripte laufen,
 *    keine fremden Seiten dürfen uns einbetten, Formulare gehen nur an uns.
 * Läuft in Node (nicht Edge), damit die Sitzungs-Version aus der Datenbank geprüft werden kann.
 */
const PUBLIC = ["/login", "/setup", "/api/health", "/api/shopify/webhook", "/robots.txt"]; // Webhook prüft selbst per HMAC
const dev = process.env.NODE_ENV !== "production";

function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    // strict-dynamic: Skripte, die unsere Skripte nachladen, sind erlaubt; wasm-unsafe-eval für den Barcode-Leser (WebAssembly)
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cdn.shopify.com",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    // WhatsApp Web im Rahmen der Seite „WhatsApp“ (mit der Erweiterung, src/lib/wa-extension.ts)
    "frame-src 'self' https://web.whatsapp.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!isPublic) {
    const s = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
    const a = s ? await loadAccess(s.uid, s.sv) : null;
    if (!s || !a || !a.active || a.sv !== s.sv) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      const res = NextResponse.redirect(url);
      if (req.cookies.has(SESSION_COOKIE)) res.cookies.delete(SESSION_COOKIE); // abgelaufene, abgemeldete oder gesperrte Sitzung entfernen
      return res;
    }
    const api = pathname.startsWith("/api/");
    // Einmal-Passwort → erst ein eigenes Passwort (alles andere zu)
    if (a.mustChange && !pathname.startsWith("/password")) {
      if (api) return new NextResponse("Forbidden", { status: 403 });
      const url = req.nextUrl.clone();
      url.pathname = "/password";
      url.search = "";
      return NextResponse.redirect(url);
    }
    // Recht für diese Seite/API? Sonst Startseite mit Hinweis (bzw. 403)
    if (!allowed(a, routeNeed(pathname))) {
      if (api) return new NextResponse("Forbidden", { status: 403 });
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.search = "?denied=1";
      return NextResponse.redirect(url);
    }
  }
  if (pathname.startsWith("/api/")) return NextResponse.next(); // Dateien/PDFs setzen eigene Kopfzeilen

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp); // Next.js liest den Nonce daraus und setzt ihn an seine Skripte
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  runtime: "nodejs",
  // Server-Actions (Kopfzeile next-action) und der Shop-Webhook laufen NICHT durch den Türsteher:
  // Next.js 15.5 wartet bei Node-Middleware nicht, bis der für sie kopierte Body fertig ist (`finalize()` ohne await,
  // erst in Next 16 behoben). Kommt ein Upload über ~64 KB in Stücken an (Render-Proxy), fehlte der Action der Anfang
  // samt Datei (06.11.2026: „Beleg lesen“ → pickFirst, Belegfotos/Produktfotos still weg).
  // Sicher, weil jede Server-Action selbst requireSession() prüft (gleiche Prüfung inkl. Sitzungs-Version) und der Webhook per HMAC.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|brand/|fonts/|api/shopify/webhook|api/whatsapp/webhook|api/backup/upload).*)",
      missing: [{ type: "header", key: "next-action" }],
    },
  ],
};
