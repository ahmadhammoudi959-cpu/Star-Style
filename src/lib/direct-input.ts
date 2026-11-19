/**
 * Eingaben vom Bestell-Link prüfen (öffentlich, ohne Anmeldung – darum streng): Pflicht sind Name, E-Mail und mindestens eine
 * Position (aus dem Katalog oder von Hand); alles andere ist freiwillig und in der Länge begrenzt. Unverbindliche Liste – kein
 * Kauf, kein Bezahlen. Rein, getestet.
 */
import { z } from "zod";
import { DIRECT_MANUAL_MAX_CENTS, DIRECT_MAX_LINES, DIRECT_MAX_MANUAL, DIRECT_MAX_QTY, cleanVatId, mergeCart, normalizeEmail } from "./direct-rules";

const text = (max: number) => z.string().max(max * 2).transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max));

export const DIRECT_LANGS = ["de", "ar", "en", "ku"] as const;

export const directOrderSchema = z.object({
  name: text(120).pipe(z.string().min(2)),
  email: z.string().max(200).transform(normalizeEmail).pipe(z.email()),
  company: text(160).default(""),
  phone: text(40).pipe(z.string().regex(/^[0-9+()\-/ .]*$/)).default(""),
  street: text(160).default(""),
  zip: text(16).default(""),
  city: text(100).default(""),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default("DE"),
  vatId: z.string().max(40).transform(cleanVatId).pipe(z.string().max(20).regex(/^[A-Z0-9]*$/)).default(""),
  note: text(1000).default(""),
  /** Falle für Programme: Menschen sehen das Feld nicht */
  website: z.string().max(200).default(""),
  /** Millisekunden zwischen Öffnen der Seite und Absenden */
  elapsedMs: z.number().int().min(0).max(1e10),
  lang: z.enum(DIRECT_LANGS).default("de"),
  lines: z.array(z.object({ variantId: z.string().min(1).max(64), qty: z.number().int().min(1).max(DIRECT_MAX_QTY) }))
    .max(DIRECT_MAX_LINES).default([]).transform(mergeCart),
  /** Artikel von Hand (nicht im System): Name Pflicht, Preis netto je Stück oder null (= auf Anfrage), Foto = Feldname im Formular */
  manual: z.array(z.object({
    name: text(120).pipe(z.string().min(1)),
    qty: z.number().int().min(1).max(DIRECT_MAX_QTY),
    priceCents: z.number().int().min(0).max(DIRECT_MANUAL_MAX_CENTS).nullable().default(null),
    size: text(40).default(""),
    color: text(40).default(""),
    photo: z.string().regex(/^p\d{1,2}$/).nullable().default(null),
  })).max(DIRECT_MAX_MANUAL).default([]),
}).superRefine((d, ctx) => {
  // mindestens eine Position – aus dem Katalog oder von Hand
  if (!d.lines.length && !d.manual.length) ctx.addIssue({ code: "custom", path: ["lines"], message: "empty" });
  const keys = d.manual.flatMap((m) => (m.photo ? [m.photo] : []));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["manual"], message: "photo" });
});
export type DirectOrderInput = z.infer<typeof directOrderSchema>;

/** Welches Feld war falsch? (für eine verständliche Meldung im Browser) */
export function parseDirectOrder(body: unknown): { ok: true; data: DirectOrderInput } | { ok: false; field: string } {
  const r = directOrderSchema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  const f = String(r.error.issues[0]?.path?.[0] ?? "form");
  return { ok: false, field: f };
}
