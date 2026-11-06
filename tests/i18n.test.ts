import { describe, expect, it } from "vitest";
import de from "../src/i18n/de";
import ar from "../src/i18n/ar";
import en from "../src/i18n/en";
import ku from "../src/i18n/ku";

// TypeScript prüft nur, dass alle Schlüssel da sind. Hier zusätzlich: gleiche Platzhalter {x} wie de.ts
// (sonst steht im Text z. B. „{n}“ statt der Zahl), Listen gleich lang, nichts leer, Kurdisch ohne arabische Schrift.
type Leaf = { path: string; value: unknown };
function leaves(v: unknown, path = ""): Leaf[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [{ path, value: v }];
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const base = new Map(leaves(de).map((l) => [l.path, l.value]));

describe.each([["ar", ar], ["en", en], ["ku", ku]] as const)("Sprache %s", (name, dict) => {
  const own = leaves(dict);
  it("hat genau die Texte von de.ts", () => {
    expect(own.map((l) => l.path).sort()).toEqual([...base.keys()].sort());
  });
  it("hat dieselben Platzhalter wie de.ts", () => {
    const wrong = own.filter((l) => typeof l.value === "string" && placeholders(l.value) !== placeholders(String(base.get(l.path) ?? "")));
    expect(wrong.map((l) => `${name}.${l.path}: ${String(l.value)}`)).toEqual([]);
  });
  it("hat keine leeren Texte", () => {
    const empty = own.filter((l) => typeof l.value === "string" && !l.value.trim() && String(base.get(l.path) ?? "").trim());
    expect(empty.map((l) => l.path)).toEqual([]);
  });
});

describe("Kurdî (Kurmancî)", () => {
  it("ist in lateinischer Schrift, ohne arabische Zeichen", () => {
    const arabic = leaves(ku).filter((l) => typeof l.value === "string" && /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(l.value));
    expect(arabic.map((l) => l.path)).toEqual([]);
  });
  it("benutzt die kurdischen Buchstaben (Hawar)", () => {
    expect(ku.common.save).toBe("Tomar bike");
    expect(ku.nav.customers).toBe("Mişterî");
    expect(leaves(ku).some((l) => typeof l.value === "string" && /[çşêîû]/.test(l.value))).toBe(true);
  });
});
