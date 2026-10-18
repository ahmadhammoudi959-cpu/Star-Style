import "server-only";

/**
 * Prüfung ausländischer USt-IdNr.
 * 1. BZSt eVatR (qualifizierte Bestätigung – Name/Ort werden abgeglichen; rechtlich stärkster Nachweis)
 * 2. EU VIES als Ergänzung/Fallback
 * Beide Dienste sind kostenlos. Ergebnisse werden vollständig gespeichert (Nachweis für die Betriebsprüfung).
 */

export type VatCheckResult = {
  source: "BZST" | "VIES";
  valid: boolean | null; // null = Dienst nicht erreichbar / keine Aussage
  name: string;
  address: string;
  error: string;
  raw: unknown;
};

export function splitVatId(vatId: string): { country: string; number: string } | null {
  const v = vatId.replace(/[\s.-]/g, "").toUpperCase();
  const m = /^([A-Z]{2})([0-9A-Z+*]{2,13})$/.exec(v);
  return m ? { country: m[1], number: m[2] } : null;
}

const MATCH: Record<string, string> = { A: "stimmt überein", B: "stimmt nicht überein", C: "nicht angefragt", D: "vom EU-Mitgliedsstaat nicht mitgeteilt" };

async function timedFetch(url: string, init: RequestInit, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

export async function checkBzst(p: { ownVatId: string; vatId: string; company: string; city: string; zip?: string; street?: string }): Promise<VatCheckResult> {
  const body = {
    anfragendeUstid: p.ownVatId.replace(/\s/g, "").toUpperCase(),
    angefragteUstid: p.vatId.replace(/\s/g, "").toUpperCase(),
    firmenname: p.company, ort: p.city, plz: p.zip ?? "", strasse: p.street ?? "",
  };
  try {
    const res = await timedFetch("https://api.evatr.vies.bzst.de/app/v1/abfrage", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, string>;
    const ok = json.status === "evatr-0000";
    const detail = ["ergFirmenname", "ergOrt", "ergPlz", "ergStrasse"]
      .map((k) => (json[k] ? `${k.replace("erg", "")}: ${MATCH[json[k]] ?? json[k]}` : "")).filter(Boolean).join(" · ");
    return { source: "BZST", valid: ok ? true : json.status ? false : null, name: "", address: detail, error: ok ? "" : String(json.status ?? res.status), raw: json };
  } catch (e) {
    return { source: "BZST", valid: null, name: "", address: "", error: e instanceof Error ? e.message : "network", raw: null };
  }
}

export async function checkVies(vatId: string): Promise<VatCheckResult> {
  const s = splitVatId(vatId);
  if (!s) return { source: "VIES", valid: false, name: "", address: "", error: "format", raw: null };
  const countryCode = s.country === "GR" ? "EL" : s.country;
  try {
    const res = await timedFetch("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ countryCode, vatNumber: s.number }),
    });
    const json = (await res.json()) as { valid?: boolean; name?: string; address?: string; userError?: string; errorWrappers?: { error: string }[] };
    const err = json.errorWrappers?.[0]?.error ?? (json.userError && json.userError !== "VALID" && json.userError !== "INVALID" ? json.userError : "");
    return {
      source: "VIES", valid: err ? null : Boolean(json.valid), name: (json.name ?? "").replace(/^---$/, ""),
      address: (json.address ?? "").replace(/^---$/, "").replace(/\n/g, ", "), error: err, raw: json,
    };
  } catch (e) {
    return { source: "VIES", valid: null, name: "", address: "", error: e instanceof Error ? e.message : "network", raw: null };
  }
}
