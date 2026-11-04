import qrcode from "qrcode-generator";

/** QR-Code als SVG-Pfad (ein Kästchen = 1 Einheit) – zeichnet die Seite selbst, ohne HTML einzuschleusen */
export function qrSvgPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size: n, d };
}
