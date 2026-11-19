import "server-only";
/**
 * Texte fürs Werbebild einer Aktion (Wunsch Inhaber 19.11.2026: „الذكاء الاصطناعي بينشئ الصوره“): Überschrift, Unterzeile und
 * Kurznamen der Artikel in den vier Shop-Sprachen. Die Zahl („−20%“), die Fotos, „Nur bis …“ und der Knopf kommen vom System –
 * die KI schreibt nur Worte und darf nichts versprechen (keine Preise, Lieferzeiten, Vorrat, „nur heute“, Marken, Vergleiche).
 * Ohne KI oder bei Fehler: feste Texte (fallbackCopy), damit das Bild trotzdem entsteht.
 */
import { AiError, aiConfigured, callClaude, type ContentBlock, type Tool } from "./client";
import { IDENTITY_RULE } from "./identity";

export const COPY_LANGS = ["de", "en", "ar", "nl"] as const;
export type CopyLang = (typeof COPY_LANGS)[number];
export type BannerCopy = { headline: string; sub: string; names: string[] };
export type CopyProduct = { name: string; nameNl: string; category: string };

/** Längen fürs Bild (danach wird gekürzt) */
export const COPY_LIMITS = { headline: 40, headlineAr: 34, sub: 52, subAr: 44, name: 26 };

const FALLBACK: Record<CopyLang, { headline: string; sub: string }> = {
  de: { headline: "Profi-Ausstattung im Angebot", sub: "Ausgewählte Artikel reduziert" },
  en: { headline: "Pro equipment on sale", sub: "Selected items reduced" },
  ar: { headline: "معدات احترافية بسعر مخفّض", sub: "منتجات مختارة عليها خصم" },
  nl: { headline: "Professionele uitrusting in de aanbieding", sub: "Geselecteerde artikelen afgeprijsd" },
};

/** Kurzname ohne Markenvorsatz und ohne Farbe/Maß nach „–“ (z. B. „DeltaPro Barberstuhl Legend – Schwarz“ → „Barberstuhl Legend“) */
export function shortName(name: string): string {
  let s = name.replace(/\s+/g, " ").trim();
  s = s.replace(/^(DeltaPro|Delta Pro|Q-Design|Star Style)\s+/i, "");
  const dash = s.search(/\s[–-]\s/);
  if (dash > 8) s = s.slice(0, dash);
  return cut(s, COPY_LIMITS.name);
}

/** auf höchstens n Zeichen kürzen, an einer Wortgrenze */
export function cut(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim().replace(/^["'„“”«»]+|["'„“”«»]+$/g, "");
  if (t.length <= n) return t;
  const part = t.slice(0, n + 1);
  const sp = part.lastIndexOf(" ");
  return (sp > n * 0.5 ? part.slice(0, sp) : t.slice(0, n)).replace(/[\s,;:–-]+$/, "");
}

export function fallbackCopy(products: CopyProduct[]): Record<CopyLang, BannerCopy> {
  return Object.fromEntries(COPY_LANGS.map((l) => [l, {
    ...FALLBACK[l],
    names: products.map((p) => shortName(l === "nl" && p.nameNl ? p.nameNl : p.name)),
  }])) as Record<CopyLang, BannerCopy>;
}

/** Antwort der KI prüfen: alles da, gekürzt, ohne Prozentzahl/Preis (stünde sonst doppelt bzw. falsch im Bild) */
export function cleanCopy(raw: unknown, products: CopyProduct[]): Record<CopyLang, BannerCopy> {
  const fb = fallbackCopy(products);
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, { headline?: unknown; sub?: unknown; names?: unknown }>;
  const bad = /\d+\s*%|%\s*\d+|€|\beur\b|\d+[.,]\d{2}/i;
  const out = {} as Record<CopyLang, BannerCopy>;
  for (const l of COPY_LANGS) {
    const x = src[l] ?? {};
    const ar = l === "ar";
    const h = typeof x.headline === "string" ? cut(x.headline, ar ? COPY_LIMITS.headlineAr : COPY_LIMITS.headline) : "";
    const s = typeof x.sub === "string" ? cut(x.sub, ar ? COPY_LIMITS.subAr : COPY_LIMITS.sub) : "";
    const names = Array.isArray(x.names) ? x.names : [];
    out[l] = {
      headline: h && !bad.test(h) ? h : fb[l].headline,
      sub: s && !bad.test(s) ? s : fb[l].sub,
      names: products.map((_, i) => {
        const n = typeof names[i] === "string" ? cut(names[i] as string, COPY_LIMITS.name) : "";
        return n && !bad.test(n) ? n : fb[l].names[i];
      }),
    };
  }
  return out;
}

const LANG_OBJ = {
  type: "object",
  properties: {
    headline: { type: "string", description: "Headline, max 32 characters (Arabic max 26)" },
    sub: { type: "string", description: "Second line, max 45 characters (Arabic max 38)" },
    names: { type: "array", items: { type: "string" }, description: "Short display name per product, same order, max 22 characters each" },
  },
  required: ["headline", "sub", "names"],
  additionalProperties: false,
};
const TOOL: Tool = {
  name: "banner_texts",
  description: "Record the texts for the promotional banner in German, English, Arabic and Dutch.",
  input_schema: { type: "object", properties: { de: LANG_OBJ, en: LANG_OBJ, ar: LANG_OBJ, nl: LANG_OBJ }, required: ["de", "en", "ar", "nl"], additionalProperties: false },
};

const SYSTEM = `You write the words for a promotional web banner of "Star Style", a German B2B wholesaler of barber and hairdresser supplies (customers: hair salons and barbershops). The banner already shows the discount big (e.g. "−20%"), the product photos, an end date if there is one, and a button; you only write a headline, a second line and a short display name for each product.
Rules:
- Natural, idiomatic, short text in each language: German (address the customer formally with "Sie" or use no pronoun), English, Dutch (use "u" or no pronoun) and Arabic (clear Modern Standard Arabic).
- Say what kind of products these are (from the names and categories). Do not invent features, materials or numbers.
- Never mention prices, amounts, percentages (the discount is already on the banner), currencies, free shipping, delivery times, stock or limited quantities, "only today", guarantees, "best"/"cheapest" or comparisons with competitors. Do not add brand names that are not in the product names.
- Words like "reduziert", "im Angebot", "on sale", "in de aanbieding", "بسعر مخفّض" are fine.
- No emojis, hashtags or quotation marks; at most one exclamation mark per language.
- Product display names: keep the model name (e.g. "Barberstuhl Legend"), drop brand prefixes such as "DeltaPro" and colour/size suffixes. In Arabic write the product type in Arabic and keep the model name in Latin letters when it has no Arabic form.
- Dutch terms: Barberstuhl = barberstoel, Friseurstuhl = kappersstoel, Waschliege = wasligbed, Rückwärtswaschanlage = achterwasunit, Empfangstheke = receptiebalie, Friseurwagen = kapperswagen, Haarschneidemaschine = tondeuse, Haartrockner/Föhn = föhn, Spiegel = spiegel, Wartesofa = wachtbank.
Always answer by calling the banner_texts tool.
${IDENTITY_RULE}`;

/**
 * Texte schreiben lassen. variant = Zähler fürs „Neue Bild“, damit es andere Worte gibt.
 * Gibt immer Texte zurück (ai = false → feste Texte, z. B. KI nicht eingerichtet oder Fehler).
 */
export async function promoCopy(products: CopyProduct[], variant: number, opts: { fetchImpl?: typeof fetch } = {}): Promise<{ copy: Record<CopyLang, BannerCopy>; ai: boolean }> {
  if (!products.length || !aiConfigured()) return { copy: fallbackCopy(products), ai: false };
  const list = products.map((p, i) => `${i + 1}. ${p.name}${p.nameNl && p.nameNl !== p.name ? ` | NL: ${p.nameNl}` : ""}${p.category ? ` | category: ${p.category}` : ""}`).join("\n");
  const text = `Products on the banner (in this order):\n${list}\n\nWrite version ${variant + 1} of the texts${variant ? " – choose clearly different wording from the obvious first idea" : ""}. Return exactly ${products.length} names per language.`;
  const call = (strict: boolean) => callClaude({ system: SYSTEM, tools: [strict ? { ...TOOL, strict: true } : TOOL], tool_choice: { type: "auto" }, messages: [{ role: "user", content: text }] }, { ...opts, timeoutMs: 90_000 });
  try {
    let strict = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try { res = await call(strict); } catch (e) {
        if (!(strict && e instanceof AiError && e.code === "badRequest" && /strict/i.test(e.message))) throw e;
        strict = false;
        res = await call(false);
      }
      const use = res.content.find((c) => c.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }> | undefined;
      if (use) return { copy: cleanCopy(use.input, products), ai: true };
    }
  } catch (e) {
    console.error("promo copy", e);
  }
  return { copy: fallbackCopy(products), ai: false };
}
