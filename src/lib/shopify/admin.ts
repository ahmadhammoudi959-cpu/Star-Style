import "server-only";
/**
 * Gemeinsame Bausteine für Änderungen im Shop (Artikel hochladen, Galerie, Kategorien):
 * Zugang prüfen, Token bei fehlendem Recht einmal neu holen, Fotos per staged upload, im Online Store veröffentlichen,
 * und eine Sperre je Artikel und Shop, damit nie zwei Vorgänge gleichzeitig dasselbe Shop-Produkt ändern.
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, ShopifyError, type Shop } from "./client";

export const configured = (s: Shop | undefined | null): s is Shop => Boolean(s?.domain && (s.clientSecretEnc || s.staticTokenEnc));

export const isAccessDenied = (e: unknown) => e instanceof ShopifyError && /access denied|write_products/i.test(e.message);

/** Link in den Shopify-Admin dieses Shops (z. B. „/menus“) */
export const shopAdminUrl = (shop: Pick<Shop, "domain">, path: string) =>
  `https://admin.shopify.com/store/${shop.domain.replace(/\.myshopify\.com$/, "")}${path}`;

/** Fehlt ein Recht, kann der zwischengespeicherte Token noch aus der Zeit vor der Freigabe stammen → einmal neu holen. */
export async function withFreshToken<T>(shop: Shop, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ShopifyError) || !/access denied/i.test(e.message) || shop.staticTokenEnc) throw e;
    shop.tokenEnc = ""; shop.tokenExpiresAt = null;
    await db.update(schema.shops).set({ tokenEnc: "", tokenExpiresAt: null }).where(eq(schema.shops.channel, shop.channel));
    return run();
  }
}

// Ein Artikel je Shop nie gleichzeitig zweimal (Speichern, „Alle hochladen“, Galerie): nacheinander, in Reihenfolge (läuft im Prozess, nur EINE Instanz)
const locks = new Map<string, Promise<void>>();
export async function withProductLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ───────────────────────── Fotos ─────────────────────────

const STAGED_M = `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
  stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "foto";

export type StagedImage = { resourceUrl: string; filename: string };

/** Bilder aus unserer Datenbank per staged upload zu Shopify bringen → resourceUrl je Datei (für productSet / productUpdate media). */
export async function uploadImages(shop: Shop, nameBase: string, fileIds: (string | null)[]): Promise<Map<string, StagedImage>> {
  const ids = [...new Set(fileIds.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, StagedImage>();
  if (!ids.length) return out;
  const found = await db.select().from(schema.storedFiles).where(inArray(schema.storedFiles.id, ids));
  const files = ids.map((id) => found.find((f) => f.id === id)).filter((f): f is (typeof found)[number] => Boolean(f && EXT[f.mime]));
  if (!files.length) return out;
  const names = files.map((f, i) => `${slug(nameBase)}-${i + 1}.${EXT[f.mime]}`);
  const d = await gql<{ stagedUploadsCreate: { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[]; userErrors: { message: string }[] } }>(
    shop, STAGED_M, { input: files.map((f, i) => ({ resource: "IMAGE", filename: names[i], mimeType: f.mime, httpMethod: "POST", fileSize: String(f.size) })) });
  if (d.stagedUploadsCreate.userErrors.length) throw new ShopifyError("userErrors", d.stagedUploadsCreate.userErrors.map((e) => e.message).join("; "));
  for (const [i, t] of d.stagedUploadsCreate.stagedTargets.entries()) {
    const f = files[i];
    const form = new FormData();
    for (const prm of t.parameters) form.append(prm.name, prm.value);
    form.append("file", new Blob([new Uint8Array(f.data)], { type: f.mime }), names[i]);
    const res = await fetch(t.url, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
    out.set(f.id, { resourceUrl: t.resourceUrl, filename: names[i] });
  }
  return out;
}

// ───────────────────────── Veröffentlichen ─────────────────────────

// Veröffentlichung „Online Store“ je Shop (ändert sich praktisch nie)
const publicationIds = new Map<string, string>();

/** Produkt oder Kollektion im Online Store sichtbar machen. false = Online Store nicht gefunden. */
export async function publishToOnlineStore(shop: Shop, id: string): Promise<boolean> {
  const key = `${shop.channel}:${shop.domain}`;
  let pub = publicationIds.get(key);
  if (!pub) {
    const d = await gql<{ publications: { nodes: { id: string; catalog: { title: string } | null }[] } }>(shop,
      `{ publications(first: 50, catalogType: APP) { nodes { id catalog { title } } } }`);
    pub = d.publications.nodes.find((n) => /online store/i.test(n.catalog?.title ?? ""))?.id;
    if (!pub) return false;
    publicationIds.set(key, pub);
  }
  const r = await gql<{ publishablePublish: { userErrors: { message: string }[] } }>(shop,
    `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
    { id, input: [{ publicationId: pub }] });
  if (r.publishablePublish.userErrors.length) throw new ShopifyError("userErrors", r.publishablePublish.userErrors.map((e) => e.message).join("; "));
  return true;
}
