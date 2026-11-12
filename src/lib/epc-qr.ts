import qrcode from "qrcode-generator";

/**
 * EPC-QR-Code („GiroCode“, EPC069-12 Version 002) für SEPA-Überweisungen: Banking-Apps übernehmen damit Empfänger,
 * IBAN, Betrag und Verwendungszweck – „Scannen & bezahlen“ auf der Rechnung (Vorbild Inhaber 12.11.2026).
 * null = Daten reichen nicht (keine gültige IBAN, kein Name, Betrag außerhalb 0,01–999.999.999,99 €).
 */
export function epcPayload(o: { name: string; iban: string; bic?: string; amountCents: number; text: string }): string | null {
  const iban = o.iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return null;
  if (!Number.isInteger(o.amountCents) || o.amountCents < 1 || o.amountCents > 99999999999) return null;
  const clean = (s: string, max: number) => [...s.replace(/[\r\n]+/g, " ").trim()].slice(0, max).join("");
  const name = clean(o.name, 70);
  if (!name) return null;
  const bic = (o.bic ?? "").replace(/\s+/g, "").toUpperCase();
  const amount = `EUR${Math.floor(o.amountCents / 100)}.${String(o.amountCents % 100).padStart(2, "0")}`;
  // Dienst, Version, Zeichensatz (1 = UTF-8), SEPA, BIC (optional), Name, IBAN, Betrag, Zweck, strukturierte Referenz, Text
  return ["BCD", "002", "1", "SCT", /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic) ? bic : "", name, iban, amount, "", "", clean(o.text, 140)].join("\n");
}

/** QR-Matrix (true = dunkel), Fehlerkorrektur M wie vom EPC verlangt, Text als UTF-8 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  // Die Bibliothek nimmt je Zeichen ein Byte (charCode & 0xff) → UTF-8-Bytes als „ein Zeichen je Byte“ übergeben
  qr.addData(Buffer.from(text, "utf8").toString("latin1"), "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** QR-Matrix als SVG-Pfad (Läufe je Zeile zusammengefasst, 1 Kästchen = 1 Einheit) */
export function modulesPath(m: boolean[][]): string {
  let d = "";
  m.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      let e = c;
      while (e + 1 < row.length && row[e + 1]) e++;
      d += `M${c} ${r}h${e - c + 1}v1h${-(e - c + 1)}z`;
      c = e;
    }
  });
  return d;
}
