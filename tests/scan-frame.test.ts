import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareScanFrame, scanFrameMode } from "../src/lib/barcode";

/**
 * Weißer Barcode auf rotem Karton (Wunsch Inhaber 12.11.2026: „الأحمر ما عم ينقرا، الأسود فورًا“).
 * Nachgestellt mit einem gezeichneten EAN-13 (Farben aus dem Foto des Kartons, leicht unscharf, Rauschen) und ZXing
 * mit ausgeschaltetem „Umdrehen“ – so verhält sich der eingebaute Leser von Android.
 */
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = L.map((s) => [...s].map((c) => (c === "1" ? "0" : "1")).join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function ean13Modules(code: string): string {
  const d = code.split("").map(Number);
  let s = "101";
  for (let i = 1; i <= 6; i++) s += (PARITY[d[0]][i - 1] === "L" ? L : G)[d[i]];
  s += "01010";
  for (let i = 7; i <= 12; i++) s += R[d[i]];
  return s + "101";
}

type Rgb = [number, number, number];
/** Bild wie aus der Kamera: Striche/Grund in Farbe, 3 px je Modul, etwas unscharf, etwas Rauschen */
function render(code: string, bar: Rgb, ground: Rgb) {
  const mods = ean13Modules(code), unit = 3, quiet = 14, width = (mods.length + 2 * quiet) * unit, height = 90;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 21) - 10; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // unscharf: Mittelwert über ±1 px
    let acc: Rgb = [0, 0, 0];
    for (let dx = -1; dx <= 1; dx++) {
      const m = Math.floor((x + dx) / unit) - quiet;
      const c = m >= 0 && m < mods.length && mods[m] === "1" && y > 10 && y < height - 10 ? bar : ground;
      acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
    }
    const i = (y * width + x) * 4;
    for (let k = 0; k < 3; k++) data[i + k] = acc[k] / 3 + noise();
    data[i + 3] = 255;
  }
  return { data, width, height };
}

const CODE = "8721399641217"; // Barcode vom Karton im Foto
const WHITE: Rgb = [250, 240, 232], RED: Rgb = [208, 84, 74], BLACK: Rgb = [30, 30, 34];

type Reader = (img: { data: Uint8ClampedArray; width: number; height: number }, o: Record<string, unknown>) => Promise<{ text: string }[]>;
let read: Reader;

beforeAll(async () => {
  const z = await import("zxing-wasm/reader");
  // dieselbe Datei, die /api/zxing/[version] an die Handys ausliefert
  const wasm = readFileSync(join(process.cwd(), "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"));
  await z.prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(wasm).buffer }, fireImmediately: true });
  read = z.readBarcodes as unknown as Reader;
});

// wie der eingebaute Leser: nichts selbst umdrehen
const plain = { formats: ["EAN13"], tryInvert: false, tryHarder: true, tryRotate: false, tryDownscale: false };
const texts = async (img: { data: Uint8ClampedArray; width: number; height: number }) => (await read(img, plain)).map((r) => r.text);
const copy = (img: { data: Uint8ClampedArray; width: number; height: number }) => ({ ...img, data: new Uint8ClampedArray(img.data) });

describe("Barcode auf farbigem Karton", () => {
  it("weiß auf rot: unverändert nicht lesbar (Fehler nachgestellt), umgedreht sofort", async () => {
    const img = render(CODE, WHITE, RED);
    expect(await texts(img)).toEqual([]);
    const inv = copy(img);
    prepareScanFrame(inv.data, true);
    expect(await texts(inv)).toEqual([CODE]);
  });

  it("schwarz auf weiß: unverändert lesbar wie bisher (darum bleibt jedes zweite Bild unverändert)", async () => {
    const img = render(CODE, BLACK, WHITE);
    expect(await texts(img)).toEqual([CODE]);
    const col = copy(img);
    prepareScanFrame(col.data, false);
    expect(await texts(col)).toEqual([CODE]);
  });

  it("rote Striche auf weiß: mit Farbverstärkung lesbar", async () => {
    const col = render(CODE, RED, WHITE);
    prepareScanFrame(col.data, false);
    expect(await texts(col)).toEqual([CODE]);
  });

  it("weiß auf blau/grün/schwarz: umgedreht lesbar", async () => {
    for (const ground of [[25, 60, 170], [20, 120, 60], [20, 20, 20]] as Rgb[]) {
      const inv = render(CODE, WHITE, ground);
      prepareScanFrame(inv.data, true);
      expect(await texts(inv), String(ground)).toEqual([CODE]);
    }
  });

  it("Graustufe: dunkelster Kanal, Kontrast gestreckt, einfarbig bleibt ruhig", () => {
    const d = new Uint8ClampedArray([208, 84, 74, 255, 250, 240, 232, 255]);
    prepareScanFrame(d, false);
    expect([d[0], d[1], d[2], d[4]]).toEqual([0, 0, 0, 255]);
    const e = new Uint8ClampedArray([208, 84, 74, 255, 250, 240, 232, 255]);
    prepareScanFrame(e, true);
    expect([e[0], e[4]]).toEqual([255, 0]);
    const flat = new Uint8ClampedArray([100, 120, 140, 255, 102, 121, 141, 255]);
    prepareScanFrame(flat, false);
    expect([flat[0], flat[4]]).toEqual([100, 102]);
  });

  it("Reihenfolge: jedes zweite Bild unverändert, dazwischen umgedreht und farbverstärkt", () => {
    expect([0, 1, 2, 3, 4, 5].map(scanFrameMode)).toEqual(["raw", "inverted", "raw", "color", "raw", "inverted"]);
  });
});
