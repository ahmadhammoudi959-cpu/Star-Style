import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Lese-Modul (WebAssembly) für den Barcode-Scanner auf Geräten ohne eingebauten Barcode-Leser (z. B. iPhone).
 * Kommt aus node_modules – passt damit immer zur installierten Version; die Version steht in der Adresse (lange zwischenspeicherbar).
 */
let cached: Buffer | null = null;

export async function GET() {
  cached ??= await readFile(path.join(process.cwd(), "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"));
  return new Response(new Uint8Array(cached), {
    headers: { "content-type": "application/wasm", "cache-control": "public, max-age=31536000, immutable" },
  });
}
