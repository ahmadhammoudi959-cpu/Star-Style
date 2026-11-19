import "server-only";
/**
 * Direktverkauf über den Bestell-Link (Wunsch Inhaber 19.11.2026: „بيعطيه تاب فيه لينك … شاف الجاليري … حطهم بالعربة وبعتهم …
 * اجوا على السيستم وليس على المتجر الالكتروني“). Katalog zum Zeigen und Auswählen – auf dem Tablet im Büro oder als Link an
 * einen Händler: Fotos, Beschreibung, Größen/Farben, Preis (netto) und nur „verfügbar/nicht verfügbar“. Der Kunde schickt
 * eine Liste mit Name + E-Mail (Pflicht) – ohne Bezahlen, ohne Shop. Unter „Direktverkauf“ wählt der Mitarbeiter den Kunden
 * (oder legt ihn ganz normal an) und macht daraus ein Angebot oder einen Rechnungsentwurf mit den Preisen dieses Kunden.
 * Das System legt nie selbst einen Kunden an.
 *
 * Zwei Links, je Preisgruppe einer: „جملة“ (RETAIL, Salons) und „جملة الجملة“ (WHOLESALE, Wiederverkäufer) – „اسعارهم جملة
 * او جملة الجملة“. Sicherheit: /b und /api/b laufen ohne Anmeldung (Middleware PUBLIC) und prüfen selbst das Token
 * (sha256 in company_settings.direct_link, zeitkonstant verglichen; Klartext nur AES-GCM-verschlüsselt zum Anzeigen).
 * Sichtbar sind nur aktive Artikel, die in einem Shop sichtbar sind und einen Preis haben, und nur deren Fotos – nie
 * Einkaufspreis, Bestandszahl, Kunden oder Belege. Begrenzung je Netz (HMAC der IP), je E-Mail und insgesamt.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "./crypto";
import { audit } from "./stock";
import { createDraft, saveOfferTx } from "./sales";
import { grossFromNet } from "./money";
import { addDaysIso, todayIso } from "./dates";
import { productPhotoIds } from "./product-photos";
import { activeDiscounts } from "./promotions";
import { discounted } from "./promo-rules";
import { directPhotoWebp } from "./direct-photos";
import {
  DIRECT_GROUPS, DIRECT_KEEP_DAYS, DIRECT_MANUAL_VAT_BP, DIRECT_MIN_FILL_MS, cartProblems, directState, lineDescription, listTotals, looksLikeToken,
  photoLimited, rateLimited, type CatalogProduct, type DirectGroup, type DirectState,
} from "./direct-rules";
import type { DirectOrderInput } from "./direct-input";

export class DirectError extends Error {
  constructor(
    public code: "closed" | "rate" | "bot" | "unavailable" | "notFound" | "done" | "customer" | "noLines" | "photo" | "photoRate" | "manual",
    public problems?: { variantId: string; available: number }[],
  ) {
    super(code);
  }
}

// ───────────────────────── Links (je Preisgruppe) ─────────────────────────
type LinkEntry = { enc?: string; hash?: string; on?: boolean; at?: string };
type LinkRow = Partial<Record<DirectGroup, LinkEntry>>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// kurz zwischenspeichern (jede Katalogseite lädt Dutzende Fotos über /api/b) – auf globalThis wie der Sitzungs-Speicher
const g = globalThis as { __ssDirectLink?: { at: number; row: LinkRow } };
export function forgetDirectLink() { g.__ssDirectLink = undefined; }

async function linkRow(fresh = false): Promise<LinkRow> {
  const c = g.__ssDirectLink;
  if (!fresh && c && Date.now() - c.at < 10_000) return c.row;
  const s = await db.query.companySettings.findFirst({ columns: { directLink: true } });
  const raw = (s?.directLink ?? {}) as Record<string, unknown>;
  const row: LinkRow = {};
  for (const grp of DIRECT_GROUPS) {
    const e = raw[grp];
    if (e && typeof e === "object") row[grp] = e as LinkEntry;
  }
  g.__ssDirectLink = { at: Date.now(), row };
  return row;
}

export type DirectLinkInfo = { group: DirectGroup; exists: boolean; on: boolean; token: string | null; since: string | null };
export async function directLinks(): Promise<DirectLinkInfo[]> {
  const r = await linkRow(true);
  return DIRECT_GROUPS.map((group) => {
    const e = r[group] ?? {};
    let token: string | null = null;
    try { token = e.enc ? decrypt(e.enc) : null; } catch { token = null; } // SESSION_SECRET geändert → neuen Link erstellen
    return { group, exists: !!e.hash, on: !!e.on && !!e.hash, token, since: e.at ?? null };
  });
}

/** Zu welcher Preisgruppe gehört dieses Token (nur eingeschaltete Links)? Falsche Form → gar nicht erst nachsehen. */
export async function linkGroup(token: string): Promise<DirectGroup | null> {
  if (!looksLikeToken(token)) return null;
  const r = await linkRow();
  const mine = Buffer.from(sha(token), "hex");
  let found: DirectGroup | null = null;
  for (const grp of DIRECT_GROUPS) {
    const e = r[grp];
    if (!e?.hash || !/^[0-9a-f]{64}$/.test(e.hash)) continue;
    if (timingSafeEqual(mine, Buffer.from(e.hash, "hex")) && e.on) found = grp; // alle vergleichen (gleiche Zeit)
  }
  return found;
}

async function writeLink(group: DirectGroup, entry: LinkEntry, action: string, userId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from company_settings where id = 'company' for update`);
    const cur = ((await tx.query.companySettings.findFirst({ columns: { directLink: true } }))?.directLink ?? {}) as Record<string, LinkEntry>;
    const before = cur[group];
    const next = { ...cur, [group]: entry };
    await tx.insert(schema.companySettings).values({ id: "company", directLink: next })
      .onConflictDoUpdate({ target: schema.companySettings.id, set: { directLink: next } });
    // nie das Token ins Protokoll – nur ob es da/an war
    await audit(tx, { entity: "settings", entityId: `direct_link/${group}`, action, before: { on: !!before?.on, exists: !!before?.hash }, after: { on: !!entry.on, exists: !!entry.hash }, userId });
  });
  forgetDirectLink();
}

/** Neuer Link für diese Preisgruppe (der alte gilt sofort nicht mehr) */
export async function newDirectLink(group: DirectGroup, userId: string): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  const before = (await linkRow(true))[group];
  await writeLink(group, { enc: encrypt(token), hash: sha(token), on: true, at: new Date().toISOString() }, before?.hash ? "renew" : "create", userId);
  return token;
}

export async function setDirectLinkOn(group: DirectGroup, on: boolean, userId: string) {
  const e = (await linkRow(true))[group];
  if (!e?.hash) throw new DirectError("closed");
  await writeLink(group, { ...e, on }, on ? "on" : "off", userId);
}

/** Adresse des Systems für den Link (APP_URL/RENDER_EXTERNAL_URL, sonst aus der Anfrage) */
export function directBaseUrl(h: { get(name: string): string | null }): string {
  const env = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (env) return env;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host}`;
}

// ───────────────────────── Katalog (öffentlich) ─────────────────────────
// Nur, was auch online verkauft wird: aktiv, in einem Shop sichtbar, mit Preis in der Preisgruppe des Links
const PUBLIC_PRODUCT = sql`p.active and (p.in_general_shop or p.in_brand_shop)`;
const priceOf = (group: DirectGroup): SQL => (group === "WHOLESALE"
  ? sql`coalesce(v.wholesale_price_cents, p.wholesale_price_cents)` : sql`coalesce(v.retail_price_cents, p.retail_price_cents)`);
const AVAILABLE = sql`v.stock_qty - coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0)`;

export async function publicCatalog(group: DirectGroup): Promise<CatalogProduct[]> {
  const PRICE = priceOf(group);
  const r = await db.execute<Record<string, unknown>>(sql`
    select v.id, v.product_id, p.sku, p.name_de, p.category, p.description_de, p.image_file_id as p_image, v.image_file_id as v_image,
           v.size, v.color, coalesce(v.barcode, '') as barcode, p.vat_rate_bp, ${PRICE} as price, ${AVAILABLE} as available
    from variants v join products p on p.id = v.product_id
    where v.active and ${PUBLIC_PRODUCT} and ${PRICE} > 0
    order by p.name_de, p.id, v.created_at, v.id`);
  const promo = await activeDiscounts("DIRECT"); // Aktionen am Bestell-Link
  const byId = new Map<string, CatalogProduct>();
  for (const x of r.rows) {
    const pid = String(x.product_id);
    let p = byId.get(pid);
    if (!p) {
      p = { id: pid, name: String(x.name_de), category: String(x.category ?? "").trim(), sku: String(x.sku), description: String(x.description_de ?? "").trim(),
        imageId: (x.p_image as string) ?? (x.v_image as string) ?? null, variants: [] };
      byId.set(pid, p);
    }
    const list = Number(x.price), rate = Number(x.vat_rate_bp), bp = promo.get(pid) ?? 0;
    const price = bp ? discounted(list, bp) : list;
    p.variants.push({ id: String(x.id), size: String(x.size), color: String(x.color), barcode: String(x.barcode), priceCents: price,
      grossCents: grossFromNet(price, rate), vatRateBp: rate, imageId: (x.v_image as string) ?? null, inStock: Number(x.available) > 0,
      ...(bp ? { promoPct: Math.round(bp / 100), wasCents: list, wasGrossCents: grossFromNet(list, rate) } : {}) });
  }
  return [...byId.values()];
}

/** Darf diese Datei über den Bestell-Link gezeigt werden? Nur Fotos von Artikeln aus dem Katalog. */
export async function isCatalogPhoto(fileId: string): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(sql`select exists(
    select 1 from products p where ${PUBLIC_PRODUCT} and (p.image_file_id = ${fileId}
      or exists(select 1 from variants v where v.product_id = p.id and v.active and v.image_file_id = ${fileId})
      or exists(select 1 from shop_media m where m.product_id = p.id and m.file_id = ${fileId} and not m.removed and not m.hidden))
  ) as ok`);
  return !!r.rows[0]?.ok;
}

export async function catalogPhotoIds(productId: string): Promise<string[] | null> {
  const r = await db.execute<{ ok: boolean }>(sql`select exists(select 1 from products p where p.id = ${productId} and ${PUBLIC_PRODUCT}) as ok`);
  if (!r.rows[0]?.ok) return null;
  // dieselben Regeln wie isCatalogPhoto (z. B. keine Fotos ausgeblendeter Größen/Farben), Reihenfolge wie im Artikel-Fenster
  const allowed = new Set((await db.execute<{ id: string }>(sql`
    select image_file_id as id from products where id = ${productId} and image_file_id is not null
    union select image_file_id from variants where product_id = ${productId} and active and image_file_id is not null
    union select file_id from shop_media where product_id = ${productId} and not removed and not hidden`)).rows.map((x) => String(x.id)));
  return (await productPhotoIds(productId)).filter((id) => allowed.has(id));
}

// ───────────────────────── Liste absenden (öffentlich) ─────────────────────────
const ipHashOf = (ip: string) => createHmac("sha256", process.env.SESSION_SECRET ?? "dev").update(`direct-ip:${ip}`).digest("hex").slice(0, 32);

/**
 * Liste speichern. `photos` = Fotos der Artikel von Hand aus dem Formular (Feldname p0, p1 … → Bytes, Größe schon begrenzt);
 * sie werden neu gerechnet (direct-photos.ts) und in DERSELBEN Transaktion wie die Liste gespeichert.
 */
export async function submitDirectOrder(input: DirectOrderInput, ctx: { ip: string; group: DirectGroup; photos?: Map<string, Buffer> }): Promise<{ number: number; id: string }> {
  if (input.website.trim() || input.elapsedMs < DIRECT_MIN_FILL_MS) throw new DirectError("bot");
  if (!input.lines.length && !input.manual.length) throw new DirectError("noLines");
  const ipHash = ipHashOf(ctx.ip || "-");
  const c = (await db.execute<Record<string, string>>(sql`select
      count(*) filter (where ip_hash = ${ipHash} and created_at > now() - interval '1 hour') as ip_hour,
      count(*) filter (where ip_hash = ${ipHash}) as ip_day,
      count(*) filter (where email = ${input.email}) as email_day,
      count(*) filter (where created_at > now() - interval '1 hour') as all_hour
    from direct_orders where created_at > now() - interval '1 day'`)).rows[0] ?? {};
  if (rateLimited({ ipHour: Number(c.ip_hour ?? 0), ipDay: Number(c.ip_day ?? 0), emailDay: Number(c.email_day ?? 0), allHour: Number(c.all_hour ?? 0) }))
    throw new DirectError("rate");

  // Fotos der Artikel von Hand: nur die, auf die eine Position zeigt; Begrenzung je Netz und insgesamt (24 h)
  const wanted = input.manual.flatMap((m) => (m.photo && ctx.photos?.has(m.photo) ? [m.photo] : []));
  if (wanted.length) {
    const pc = (await db.execute<Record<string, string>>(sql`select count(*) filter (where o.ip_hash = ${ipHash}) as ip_day, count(*) as all_day
      from direct_order_lines l join direct_orders o on o.id = l.order_id
      where l.photo_file_id is not null and o.created_at > now() - interval '1 day'`)).rows[0] ?? {};
    if (photoLimited({ ipDay: Number(pc.ip_day ?? 0), allDay: Number(pc.all_day ?? 0) }, wanted.length)) throw new DirectError("photoRate");
  }
  const webp = new Map<string, Buffer>();
  for (const key of wanted) { // nacheinander (Speicher)
    const out = await directPhotoWebp(ctx.photos!.get(key)!);
    if (!out) throw new DirectError("photo");
    webp.set(key, out);
  }

  const PRICE = priceOf(ctx.group);
  const ids = input.lines.map((l) => l.variantId);
  const rows = ids.length ? (await db.execute<Record<string, unknown>>(sql`
    select v.id, v.product_id, p.name_de, v.size, v.color, coalesce(v.barcode, '') as barcode, p.vat_rate_bp, ${PRICE} as price, ${AVAILABLE} as available
    from variants v join products p on p.id = v.product_id
    where v.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and v.active and ${PUBLIC_PRODUCT} and ${PRICE} > 0`)).rows : [];
  const promo = rows.length ? await activeDiscounts("DIRECT", [...new Set(rows.map((x) => String(x.product_id)))]) : new Map<string, number>();
  const info = new Map(rows.map((x) => [String(x.id), x]));
  const problems = cartProblems(input.lines, new Map(rows.map((x) => [String(x.id), Number(x.available)])));
  if (problems.length) throw new DirectError("unavailable", problems);

  const lines = input.lines.map((l, i) => {
    const x = info.get(l.variantId)!;
    return {
      position: i + 1, variantId: l.variantId, qty: l.qty, unitPriceCents: Number(x.price), vatRateBp: Number(x.vat_rate_bp), barcode: String(x.barcode),
      description: lineDescription(String(x.name_de), { size: String(x.size), color: String(x.color) }), promoBp: promo.get(String(x.product_id)) ?? 0,
    };
  });
  // Artikel von Hand: nach den Katalog-Artikeln, Preis 0 = ohne Preis (auf Anfrage), MwSt. Regelsatz
  const manual = input.manual.map((m, i) => ({
    position: lines.length + i + 1, variantId: null, qty: m.qty, unitPriceCents: m.priceCents ?? 0, vatRateBp: DIRECT_MANUAL_VAT_BP, barcode: "",
    description: lineDescription(m.name, { size: m.size, color: m.color }), promoBp: 0,
    manual: { name: m.name, size: m.size, color: m.color }, photoKey: m.photo && webp.has(m.photo) ? m.photo : null,
  }));
  // Summen mit dem Preis, den der Kunde gesehen hat (Aktion: mit Rabatt); gespeichert wird der Preis vorher + Rabatt
  const totals = listTotals(
    lines.map((l) => ({ qty: l.qty, priceCents: l.promoBp ? discounted(l.unitPriceCents, l.promoBp) : l.unitPriceCents, vatRateBp: l.vatRateBp })),
    input.manual,
  );
  return db.transaction(async (tx) => {
    const [o] = await tx.insert(schema.directOrders).values({
      name: input.name, email: input.email, company: input.company, phone: input.phone, street: input.street, zip: input.zip, city: input.city,
      country: input.country, vatId: input.vatId, note: input.note, lang: input.lang, priceGroup: ctx.group,
      netCents: totals.netCents, grossCents: totals.grossCents, ipHash,
    }).returning({ id: schema.directOrders.id, number: schema.directOrders.number });
    const fileOf = new Map<string, string>();
    for (const [key, buf] of webp) {
      const [f] = await tx.insert(schema.storedFiles).values({
        name: `liste-${o.number}-${key}.webp`, mime: "image/webp", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
      }).returning({ id: schema.storedFiles.id });
      fileOf.set(key, f.id);
    }
    const all = [
      ...lines.map((l) => ({ ...l, orderId: o.id })),
      ...manual.map(({ photoKey, ...m }) => ({ ...m, orderId: o.id, photoFileId: photoKey ? fileOf.get(photoKey) ?? null : null })),
    ];
    await tx.insert(schema.directOrderLines).values(all);
    await audit(tx, { entity: "direct", entityId: o.id, action: "create", after: {
      number: o.number, email: input.email, group: ctx.group, lines: lines.length, manual: manual.length, photos: fileOf.size, netCents: totals.netCents, source: "link",
    } });
    return { number: o.number, id: o.id };
  });
}

// ───────────────────────── Im System ─────────────────────────
const NEW_STATE = sql`(o.status = 'NEW' or (o.status = 'CONVERTED' and o.invoice_id is null and o.offer_id is null))`;

/** Zahl am Menüpunkt und Hinweis auf der Startseite: Listen, aus denen noch kein Angebot / keine Rechnung wurde */
export async function newDirectCount(): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`select count(*) as n from direct_orders o where ${NEW_STATE}`);
  return Number(r.rows[0]?.n ?? 0);
}

type CustomerRef = { id: string; number: number; name: string; city: string; priceGroup: "WHOLESALE" | "RETAIL" };
export type DirectRow = {
  id: string; number: number; createdAt: string; state: DirectState; group: DirectGroup; name: string; company: string; email: string; phone: string;
  netCents: number; grossCents: number; lines: number; units: number;
  /** gewählter Kunde (nach Angebot/Rechnung) */
  customer: CustomerRef | null;
  /** Vorschlag: Kunde mit derselben E-Mail (nur solange noch keiner gewählt ist) */
  suggestion: CustomerRef | null;
  invoice: { id: string; number: string | null; status: string } | null;
  offer: { id: string; number: string; status: string } | null;
};

const ref = (x: Record<string, unknown>, p: string): CustomerRef | null => (x[`${p}_id`] ? {
  id: String(x[`${p}_id`]), number: Number(x[`${p}_number`]), name: String(x[`${p}_name`]), city: String(x[`${p}_city`] ?? ""),
  priceGroup: x[`${p}_group`] === "RETAIL" ? "RETAIL" : "WHOLESALE",
} : null);

function rowOf(x: Record<string, unknown>): DirectRow {
  return {
    id: String(x.id), number: Number(x.number), createdAt: new Date(x.created_at as string).toISOString(),
    state: directState({ status: String(x.status), invoiceId: (x.invoice_id as string) ?? null, offerId: (x.offer_id as string) ?? null }),
    group: x.price_group === "WHOLESALE" ? "WHOLESALE" : "RETAIL",
    name: String(x.name), company: String(x.company), email: String(x.email), phone: String(x.phone),
    netCents: Number(x.net_cents), grossCents: Number(x.gross_cents), lines: Number(x.n_lines ?? 0), units: Number(x.n_units ?? 0),
    customer: ref(x, "c"), suggestion: x.customer_id ? null : ref(x, "s"),
    invoice: x.invoice_id ? { id: String(x.invoice_id), number: (x.i_number as string) ?? null, status: String(x.i_status ?? "") } : null,
    offer: x.offer_id ? { id: String(x.offer_id), number: String(x.of_number ?? ""), status: String(x.of_status ?? "") } : null,
  };
}

const SELECT = sql`
    select o.*, c.id as c_id, c.number as c_number, c.name as c_name, c.city as c_city, c.price_group as c_group,
      s.id as s_id, s.number as s_number, s.name as s_name, s.city as s_city, s.price_group as s_group,
      i.number as i_number, i.status as i_status, ofr.number as of_number, ofr.status as of_status,
      (select count(*) from direct_order_lines l where l.order_id = o.id) as n_lines,
      (select coalesce(sum(l.qty), 0) from direct_order_lines l where l.order_id = o.id) as n_units
    from direct_orders o
    left join customers c on c.id = o.customer_id
    left join lateral (select x.* from customers x where o.email <> '' and lower(trim(x.email)) = o.email order by x.number limit 1) s on true
    left join invoices i on i.id = o.invoice_id
    left join offers ofr on ofr.id = o.offer_id`;

export async function listDirectOrders(f: { state?: string; q?: string } = {}): Promise<DirectRow[]> {
  const q = (f.q ?? "").trim().toLowerCase().slice(0, 100);
  const numText = q.replace(/^(#|nr\.?\s*)/, "");
  const num = /^\d{1,9}$/.test(numText) ? Number(numText) : null;
  const state = f.state === "done" ? sql`o.status = 'CONVERTED' and (o.invoice_id is not null or o.offer_id is not null)`
    : f.state === "rejected" ? sql`o.status = 'REJECTED'` : f.state === "all" ? sql`true` : NEW_STATE;
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const r = await db.execute<Record<string, unknown>>(sql`${SELECT}
    where ${state} ${q ? sql`and (${num != null ? sql`o.number = ${num} or ` : sql``}lower(o.name) like ${like} or lower(o.company) like ${like} or o.email like ${like} or o.phone like ${like})` : sql``}
    order by o.created_at desc limit 300`);
  return r.rows.map(rowOf);
}

export type DirectItem = {
  id: string; variantId: string | null; productId: string | null; description: string; barcode: string; qty: number; unitPriceCents: number;
  vatRateBp: number; imageId: string | null; available: number | null; groupPrice: { WHOLESALE: number; RETAIL: number } | null;
  /** Rabatt einer Aktion, mit dem die Zeile am Bestell-Link gezeigt wurde (0 = keiner) */
  promoBp: number;
  /** Artikel von Hand (nicht im System) – Name/Größe/Farbe wie eingetippt; imageId = sein Foto */
  manual: { name: string; size: string; color: string } | null;
};
export type DirectDetail = DirectRow & {
  street: string; zip: string; city: string; country: string; vatId: string; note: string; lang: string;
  rejectReason: string; handledAt: string | null; items: DirectItem[];
};

export async function directOrderDetail(id: string): Promise<DirectDetail | null> {
  const r = await db.execute<Record<string, unknown>>(sql`${SELECT} where o.id = ${id}`);
  const x = r.rows[0];
  if (!x) return null;
  const items = (await db.execute<Record<string, unknown>>(sql`
    select l.*, v.product_id, coalesce(l.photo_file_id, v.image_file_id, p.image_file_id) as image_id,
      case when v.id is null then null else ${AVAILABLE} end as available,
      coalesce(v.wholesale_price_cents, p.wholesale_price_cents) as wholesale, coalesce(v.retail_price_cents, p.retail_price_cents) as retail
    from direct_order_lines l left join variants v on v.id = l.variant_id left join products p on p.id = v.product_id
    where l.order_id = ${id} order by l.position`)).rows;
  return {
    ...rowOf(x),
    street: String(x.street), zip: String(x.zip), city: String(x.city), country: String(x.country), vatId: String(x.vat_id), note: String(x.note),
    lang: String(x.lang), rejectReason: String(x.reject_reason), handledAt: x.handled_at ? new Date(x.handled_at as string).toISOString() : null,
    items: items.map((l) => ({
      id: String(l.id), variantId: (l.variant_id as string) ?? null, productId: (l.product_id as string) ?? null, description: String(l.description),
      barcode: String(l.barcode), qty: Number(l.qty), unitPriceCents: Number(l.unit_price_cents), vatRateBp: Number(l.vat_rate_bp),
      imageId: (l.image_id as string) ?? null, available: l.available == null ? null : Number(l.available),
      groupPrice: l.product_id ? { WHOLESALE: Number(l.wholesale), RETAIL: Number(l.retail) } : null, promoBp: Number(l.promo_bp ?? 0),
      manual: manualOf(l.manual),
    })),
  };
}

function manualOf(v: unknown): DirectItem["manual"] {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  return { name: String(m.name ?? ""), size: String(m.size ?? ""), color: String(m.color ?? "") };
}

/**
 * Artikel von Hand → als normalen Artikel anlegen (Knopf an der Liste): Vorbelegung fürs Artikel-Formular. Preis = der
 * eingetippte Preis in der Preisgruppe des Links (جملة → Großhandelspreis Salon, جملة الجملة → Wiederverkäuferpreis).
 */
export async function manualPrefill(lineId: string) {
  const r = await db.execute<Record<string, unknown>>(sql`
    select l.manual, l.unit_price_cents, l.photo_file_id, o.price_group, o.number, o.id as order_id from direct_order_lines l join direct_orders o on o.id = l.order_id
    where l.id = ${lineId} and l.manual is not null`);
  const x = r.rows[0];
  const m = x ? manualOf(x.manual) : null;
  if (!x || !m) return null;
  return {
    ...m, priceCents: Number(x.unit_price_cents), photoFileId: (x.photo_file_id as string) ?? null, listNumber: Number(x.number), orderId: String(x.order_id),
    priceGroup: (x.price_group === "WHOLESALE" ? "WHOLESALE" : "RETAIL") as DirectGroup,
  };
}

/** Foto eines Artikels von Hand als eigenes Artikelfoto kopieren (Artikel und Liste bleiben unabhängig); null = kein solches Foto */
export async function copyManualPhoto(fileId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fileId) || !(await isManualPhoto(fileId))) return null;
  const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, fileId) });
  if (!f) return null;
  const [row] = await db.insert(schema.storedFiles).values({ name: `artikel-${f.name}`.slice(0, 200), mime: f.mime, size: f.size, sha256: f.sha256, data: f.data })
    .returning({ id: schema.storedFiles.id });
  return row.id;
}

/** Ist diese Datei das Foto eines Artikels von Hand? (darf dann Artikelfoto werden) */
export async function isManualPhoto(fileId: string): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(sql`select exists(select 1 from direct_order_lines where photo_file_id = ${fileId} and manual is not null)
    or exists(select 1 from offer_lines where photo_file_id = ${fileId} and manual) as ok`);
  return !!r.rows[0]?.ok;
}

/** Angaben aus der Liste, um den Kunden im normalen Kundenformular vorzubelegen („Neuen Kunden anlegen“ an der Liste) */
export async function directContact(id: string) {
  return db.query.directOrders.findFirst({
    where: eq(schema.directOrders.id, id),
    columns: { id: true, number: true, name: true, company: true, email: true, phone: true, street: true, zip: true, city: true, country: true, vatId: true, priceGroup: true },
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function lockOrder(tx: Tx, id: string) {
  const r = await tx.execute<{ id: string }>(sql`select id from direct_orders where id = ${id} for update`);
  if (!r.rows[0]) throw new DirectError("notFound");
  const o = await tx.query.directOrders.findFirst({ where: eq(schema.directOrders.id, id), with: { lines: true } });
  if (!o) throw new DirectError("notFound");
  return o;
}

export async function rejectDirectOrder(id: string, reason: string, userId: string) {
  await db.transaction(async (tx) => {
    const o = await lockOrder(tx, id);
    if (directState(o) !== "new") throw new DirectError("done");
    const why = reason.trim().slice(0, 500);
    await tx.update(schema.directOrders).set({ status: "REJECTED", rejectReason: why, handledBy: userId, handledAt: new Date() }).where(eq(schema.directOrders.id, id));
    await audit(tx, { entity: "direct", entityId: id, action: "reject", after: { reason: why }, userId });
  });
}

export async function reopenDirectOrder(id: string, userId: string) {
  await db.transaction(async (tx) => {
    const o = await lockOrder(tx, id);
    if (directState(o) !== "rejected") throw new DirectError("done");
    await tx.update(schema.directOrders).set({ status: "NEW", rejectReason: "", handledBy: userId, handledAt: new Date() }).where(eq(schema.directOrders.id, id));
    await audit(tx, { entity: "direct", entityId: id, action: "reopen", userId });
  });
}

/**
 * Angebot oder Rechnungsentwurf aus der Liste für den gewählten Kunden (Pflicht – das System legt keinen Kunden an).
 * Preise = Preisgruppe DIESES Kunden (aktueller Stand), wie im Rechnungs-Editor; Artikel, die es nicht mehr gibt, als
 * Freitext mit dem Preis von damals. Angebot reserviert die Ware wie jedes Angebot (gültig wie in den Einstellungen).
 * Danach prüft und ändert der Mitarbeiter alles im Editor wie immer.
 */
export async function convertDirectOrder(id: string, opts: { customerId: string; kind: "offer" | "invoice" }, userId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const o = await lockOrder(tx, id);
    if (directState(o) !== "new") throw new DirectError("done");
    if (!o.lines.length) throw new DirectError("noLines");
    // Artikel von Hand gibt es im System nicht → nur Angebot (Wunsch Inhaber 20.11.2026: „ما حنحول ابدا لفاتوره، بس كعرض سعر“)
    if (opts.kind === "invoice" && o.lines.some((l) => l.manual)) throw new DirectError("manual");
    const customer = await tx.query.customers.findFirst({ where: eq(schema.customers.id, opts.customerId) });
    if (!customer) throw new DirectError("customer");

    const vids = o.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
    const cur = vids.length ? (await tx.execute<Record<string, unknown>>(sql`
      select v.id, p.name_de, v.size, v.color, p.vat_rate_bp, coalesce(v.wholesale_price_cents, p.wholesale_price_cents) as wholesale,
        coalesce(v.retail_price_cents, p.retail_price_cents) as retail
      from variants v join products p on p.id = v.product_id where v.id in (${sql.join(vids.map((v) => sql`${v}`), sql`, `)})`)).rows : [];
    const byId = new Map(cur.map((x) => [String(x.id), x]));
    const lines = [...o.lines].sort((a, b) => a.position - b.position).map((l) => {
      // Artikel von Hand: Text, Preis und Foto wie eingetippt – im Angebot als „von Hand“ markiert (für die Rechnung erst als Artikel anlegen)
      if (l.manual) return { variantId: null, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: 0, vatRateBp: l.vatRateBp, manual: true, photoFileId: l.photoFileId };
      const x = l.variantId ? byId.get(l.variantId) : undefined;
      // Aktion: der Rabatt, den der Kunde am Link gesehen hat, bleibt als Positionsrabatt (auch wenn die Aktion inzwischen vorbei ist)
      if (!x) return { variantId: null, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.promoBp ?? 0, vatRateBp: l.vatRateBp };
      const price = customer.priceGroup === "RETAIL" ? Number(x.retail) : Number(x.wholesale);
      return {
        variantId: l.variantId, description: lineDescription(String(x.name_de), { size: String(x.size), color: String(x.color) }), qty: l.qty,
        unitPriceCents: price > 0 ? price : l.unitPriceCents, discountBp: l.promoBp ?? 0, vatRateBp: Number(x.vat_rate_bp),
      };
    });

    let docId: string;
    if (opts.kind === "offer") {
      const settings = await tx.query.companySettings.findFirst({ columns: { offerValidityDays: true } });
      const date = todayIso();
      docId = await saveOfferTx(tx, { customerId: customer.id, date, validUntil: addDaysIso(date, settings?.offerValidityDays ?? 14), discountBp: 0, notes: "", lines }, userId);
    } else {
      docId = await createDraft(tx, { customerId: customer.id, channel: "STORE", discountBp: 0, notes: "", lines, retentionOfTitle: true, deliveryDate: null });
      await audit(tx, { entity: "invoice", entityId: docId, action: "create_draft", after: { source: "direct", list: o.number, customerId: customer.id, lines }, userId });
    }
    await tx.update(schema.directOrders).set({
      status: "CONVERTED", customerId: customer.id, handledBy: userId, handledAt: new Date(),
      ...(opts.kind === "offer" ? { offerId: docId, invoiceId: null } : { invoiceId: docId, offerId: null }),
    }).where(eq(schema.directOrders.id, id));
    await audit(tx, { entity: "direct", entityId: id, action: opts.kind, after: { docId, customerId: customer.id }, userId });
    return docId;
  });
}

/** Datenschutz (steht so auf der Seite): abgelehnte nach 90 Tagen, Listen ohne Angebot/Rechnung nach 180 Tagen löschen */
export async function purgeDirectOrders(): Promise<number> {
  const due = sql`(o.status = 'REJECTED' and coalesce(o.handled_at, o.created_at) < now() - make_interval(days => ${DIRECT_KEEP_DAYS.rejected}))
    or (o.status <> 'REJECTED' and o.invoice_id is null and o.offer_id is null and o.created_at < now() - make_interval(days => ${DIRECT_KEEP_DAYS.open}))`;
  return db.transaction(async (tx) => {
    // Fotos der Artikel von Hand gehen mit – außer sie stecken noch in einem Angebot oder sind inzwischen Artikelfoto
    const photos = (await tx.execute<{ id: string }>(sql`select l.photo_file_id as id from direct_order_lines l join direct_orders o on o.id = l.order_id
      where l.photo_file_id is not null and (${due})`)).rows.map((x) => String(x.id));
    const r = await tx.execute(sql`delete from direct_orders o where ${due}`);
    if (photos.length) await deleteUnusedPhotos(tx, photos);
    return r.rowCount ?? 0;
  });
}

/** Fotos von Hand löschen, auf die nichts mehr zeigt (Liste, Angebot, Artikel, Größe/Farbe, Shop-Galerie) */
async function deleteUnusedPhotos(tx: Tx, ids: string[]) {
  await tx.execute(sql`delete from stored_files f where f.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    and not exists(select 1 from direct_order_lines l where l.photo_file_id = f.id)
    and not exists(select 1 from offer_lines l where l.photo_file_id = f.id)
    and not exists(select 1 from products p where p.image_file_id = f.id)
    and not exists(select 1 from variants v where v.image_file_id = f.id)
    and not exists(select 1 from shop_media m where m.file_id = f.id)`);
}
