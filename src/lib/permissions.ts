/**
 * Berechtigungen (Wunsch Inhaber 12.11.2026: „كل صلاحية مربع، المدير بيختار لكل شخص“ – flexibel, keine festen Rollen).
 * Rein, auch im Browser benutzbar (Benutzer-Formular, Menü). Gespeichert wird je Benutzer die Liste der Rechte
 * (`users.permissions`) und `is_admin` (Admin = alles + Mitarbeiter verwalten + Testbetrieb/Echtbetrieb).
 * Vorlagen (`PRESETS`) füllen im Formular nur Häkchen vor.
 * Durchgesetzt wird auf dem Server: Middleware für Seiten und API (`routeNeed`) und jede Server-Action (`requirePerm`).
 */

export const PERMISSION_GROUPS = {
  overview: ["dashboard.money", "insights", "ask"],
  products: ["products.view", "products.edit", "products.prices", "products.cost", "suppliers"],
  stock: ["stock.receive", "stock.count", "stock.writeoff"],
  sales: [
    "customers", "customers.reseller", "customers.credit", "customers.export", "sales.view", "sales.offers", "sales.invoices", "sales.discount",
    "sales.correct", "sales.delivery", "sales.shipping", "sales.email",
  ],
  money: ["payments.record", "payments.cancel", "payments.plans", "receivables", "customers.statement", "expenses.view", "expenses.edit"],
  accounting: ["reports.view", "reports.export", "reports.lock"],
  system: ["shops.view", "shops.manage", "design", "settings"],
} as const;

export type PermGroup = keyof typeof PERMISSION_GROUPS;
export type Perm = (typeof PERMISSION_GROUPS)[PermGroup][number];
export const ALL_PERMS = Object.values(PERMISSION_GROUPS).flat() as Perm[];
export const isPerm = (p: unknown): p is Perm => typeof p === "string" && (ALL_PERMS as string[]).includes(p);

/**
 * Was ein Recht mit sich bringt (sonst wäre es nutzlos): wer Rechnungen schreibt, muss Verkauf und Kunden sehen usw.
 * Im Formular werden diese Häkchen mitgesetzt und gesperrt angezeigt.
 */
export const IMPLIES: Partial<Record<Perm, Perm[]>> = {
  "products.edit": ["products.view"], "products.prices": ["products.view"], "products.cost": ["products.view"],
  "stock.receive": ["products.view"], "stock.count": ["products.view"], "stock.writeoff": ["products.view"],
  "customers.reseller": ["customers"], "customers.credit": ["customers"], "customers.statement": ["customers"], "customers.export": ["customers"],
  "sales.offers": ["sales.view", "customers", "products.view"], "sales.invoices": ["sales.view", "customers", "products.view"],
  "sales.discount": ["sales.view"], "sales.correct": ["sales.view"], "sales.delivery": ["sales.view"],
  "sales.shipping": ["sales.view"], "sales.email": ["sales.view"],
  "payments.record": ["sales.view"], "payments.cancel": ["sales.view"], "payments.plans": ["sales.view"], receivables: ["sales.view"],
  "expenses.edit": ["expenses.view"],
  "reports.export": ["reports.view"], "reports.lock": ["reports.export"],
  "shops.manage": ["shops.view"],
};

/** Gespeicherte Liste → wirksame Rechte (unbekannte Schlüssel fallen weg, Abhängigkeiten kommen dazu; Admin = alle) */
export function effectivePerms(raw: unknown, admin: boolean): Set<Perm> {
  if (admin) return new Set(ALL_PERMS);
  const out = new Set<Perm>();
  const add = (p: Perm) => { if (out.has(p)) return; out.add(p); for (const q of IMPLIES[p] ?? []) add(q); };
  for (const p of Array.isArray(raw) ? raw : []) if (isPerm(p)) add(p);
  return out;
}

/** Zum Speichern: nur bekannte Schlüssel, ohne Doppelte, in fester Reihenfolge (Abhängigkeiten mit drin) */
export const normalizePerms = (raw: unknown): Perm[] => { const s = effectivePerms(raw, false); return ALL_PERMS.filter((p) => s.has(p)); };

/** Vorlagen zum schnellen Vorbelegen (danach frei änderbar) – Vorschlag aus der Besprechung 12.11.2026 */
export const PRESETS: Record<"sales" | "warehouse" | "teamLead" | "accountant", Perm[]> = {
  sales: ["products.view", "customers", "customers.statement", "sales.offers", "sales.invoices", "sales.discount", "sales.delivery", "sales.shipping", "sales.email"],
  warehouse: ["products.view", "stock.count", "stock.writeoff", "sales.offers", "sales.invoices", "sales.discount", "sales.delivery", "sales.shipping", "insights"],
  teamLead: [
    "products.view", "products.edit", "suppliers", "stock.receive", "stock.count", "stock.writeoff", "customers", "customers.reseller", "customers.statement",
    "sales.offers", "sales.invoices", "sales.discount", "sales.correct", "sales.delivery", "sales.shipping", "sales.email", "insights", "shops.view",
  ],
  accountant: ["reports.view", "reports.export"],
};

export type Access = { admin: boolean; perms: ReadonlySet<Perm> };
/** all = jeder Angemeldete, admin = nur Admin, sonst eines der Rechte */
export type Need = "all" | "admin" | { any: Perm[] };

export function allowed(a: Access, need: Need): boolean {
  if (need === "all" || a.admin) return true;
  if (need === "admin") return false;
  return need.any.some((p) => a.perms.has(p));
}

const R = (prefix: string) => new RegExp(`^${prefix}(?:/|$)`);
/**
 * Seiten und API-Routen → nötiges Recht (Middleware). Reihenfolge zählt (erste passende Zeile gilt).
 * Unbekannte Pfade = nur Admin (neue Seiten sind zu, bis sie hier stehen; tests/permissions.test.ts prüft alle Seiten).
 */
export const ROUTES: [RegExp, Need][] = [
  [/^\/$/, "all"],
  [R("/(?:account|password|scan)"), "all"],
  [R("/settings/users"), "admin"],
  [R("/backup"), "admin"],
  [R("/api/backup"), "admin"], // /api/backup/upload läuft an der Middleware vorbei (Datei in Stücken) und prüft selbst
  [R("/settings"), { any: ["settings"] }],
  [R("/products/new"), { any: ["products.edit"] }],
  [R("/(?:products|categories|stock)"), { any: ["products.view"] }],
  [R("/receive"), { any: ["stock.receive"] }],
  [R("/write-offs"), { any: ["stock.writeoff"] }],
  [R("/suppliers"), { any: ["suppliers"] }],
  [R("/customers/[^/]+/statement"), { any: ["customers.statement"] }],
  [R("/customers"), { any: ["customers"] }],
  [R("/sales/invoices/new"), { any: ["sales.invoices"] }],
  [R("/sales/offers/new"), { any: ["sales.offers"] }],
  [R("/sales"), { any: ["sales.view"] }],
  [R("/receivables"), { any: ["receivables"] }],
  [R("/expenses/new"), { any: ["expenses.edit"] }],
  [R("/expenses"), { any: ["expenses.view"] }],
  [R("/reports/export"), { any: ["reports.export"] }],
  [R("/reports"), { any: ["reports.view"] }],
  [R("/insights"), { any: ["insights"] }],
  [R("/ask"), { any: ["ask"] }],
  [R("/shops/[^/]+/mapping"), { any: ["shops.manage"] }],
  [R("/shops"), { any: ["shops.view"] }],
  [R("/design"), { any: ["design"] }],
  // Kundenliste als Excel (alle E-Mails auf einmal) – eigenes Recht, nicht schon mit „Kunden“
  [R("/api/customers/export"), { any: ["customers.export"] }],
  [R("/api/pdf/design-preview"), { any: ["design"] }],
  [R("/api/pdf/goods-receipt"), { any: ["stock.receive"] }],
  [R("/api/pdf/dunning"), { any: ["receivables"] }],
  [R("/api/pdf/(?:invoice|offer|receipt)"), { any: ["sales.view"] }],
  // Dateien: die Route prüft selbst, wozu die Datei gehört (Beleg einer Ausgabe, Monatsmappe …)
  [R("/api/(?:files|zxing|health)"), "all"],
  [R("/_next"), "all"],
];

export function routeNeed(path: string): Need {
  for (const [re, need] of ROUTES) if (re.test(path)) return need;
  return "admin";
}

/** Darf diese Person die Seite öffnen? (Menü, Links auf der Startseite) */
export const canOpen = (a: Access, path: string) => allowed(a, routeNeed(path.split(/[?#]/)[0]));

/** Einmal-Passwort für neue Mitarbeiter: gut abzuschreiben (ohne 0/O, 1/l/I), 12 Zeichen in 3 Gruppen */
export const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function tempPassword(random: (n: number) => Uint8Array): string {
  const bytes = random(24);
  let s = "";
  for (let i = 0; s.length < 12 && i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 256 - (256 % TEMP_ALPHABET.length)) s += TEMP_ALPHABET[b % TEMP_ALPHABET.length]; // ohne Verzerrung
  }
  while (s.length < 12) s += TEMP_ALPHABET[random(1)[0] % TEMP_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
