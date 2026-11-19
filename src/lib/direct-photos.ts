import "server-only";
/**
 * Fotos von Artikeln von Hand am Bestell-Link (öffentlich, ohne Anmeldung): nur echte Bilder (Signatur JPEG/PNG/WebP, nicht
 * der angegebene Typ), höchstens 40 Megapixel (Bombe), neu als WebP gerechnet – richtig gedreht, höchstens 1600 px, ohne
 * Metadaten (Handyfotos tragen sonst den Ort der Aufnahme, GPS). Was nicht lesbar ist, wird abgelehnt.
 */
import sharp from "sharp";

export const DIRECT_PHOTO_MAX_BYTES = 6 * 1024 * 1024; // je Foto (der Browser verkleinert vorher auf ~1600 px)
const MAX_PIXELS = 40_000_000;
const EDGE = 1600;

export function looksLikeImage(buf: Buffer): boolean {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
  return buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
}

/** Foto prüfen und neu rechnen; null = kein (lesbares) Bild */
export async function directPhotoWebp(buf: Buffer): Promise<Buffer | null> {
  if (!buf.length || buf.length > DIRECT_PHOTO_MAX_BYTES || !looksLikeImage(buf)) return null;
  try {
    return await sharp(buf, { limitInputPixels: MAX_PIXELS, animated: false, failOn: "error" })
      .rotate() // Ausrichtung aus EXIF anwenden, bevor die Metadaten wegfallen
      .resize(EDGE, EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer(); // ohne withMetadata(): EXIF/GPS/ICC fallen weg
  } catch {
    return null;
  }
}
