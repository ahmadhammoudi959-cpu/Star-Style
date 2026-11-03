import { describe, expect, it } from "vitest";
import { categoryCounts, searchOptions, type SearchableOption as PickerOption } from "@/lib/product-search";

const o = (id: string, p: Partial<PickerOption>): PickerOption => ({
  id, sku: "", nameDe: "", nameNl: "", size: "", color: "", barcode: null, ...p,
});

const opts = [
  o("v1", { productId: "p1", sku: "8721399640906", barcode: "8721399640906", nameDe: "DeltaPro Ablage", category: "Werkzeug & Zubehör" }),
  o("v2", { productId: "p2", sku: "8720000100000", barcode: "8720000100000", nameDe: "Kamm", size: "S", category: "Werkzeug & Zubehör" }),
  o("v3", { productId: "p2", sku: "8720000100000", barcode: "8720000100003", nameDe: "Kamm", size: "XL", category: "Werkzeug & Zubehör" }),
  o("v4", { productId: "p3", sku: "4006381333931", barcode: "4006381333931", nameDe: "Rasiergel Ice", category: "Pflege & Verbrauch" }),
];

describe("Artikelsuche überall gleich", () => {
  it("findet nach Kategorie, Name, Barcode – exakter Barcode zuerst", () => {
    expect(searchOptions(opts, "pflege").map((x) => x.id)).toEqual(["v4"]);
    expect(searchOptions(opts, "werkzeug").map((x) => x.id)).toEqual(["v1", "v2", "v3"]);
    expect(searchOptions(opts, "8720000100003").map((x) => x.id)).toEqual(["v3"]);
    expect(searchOptions(opts, "xl").map((x) => x.id)).toEqual(["v3"]);
    expect(searchOptions(opts, "  ")).toHaveLength(4);
  });

  it("Kategorien zählen Artikel (nicht Größen/Farben), alphabetisch", () => {
    expect(categoryCounts(opts)).toEqual([{ name: "Pflege & Verbrauch", n: 1 }, { name: "Werkzeug & Zubehör", n: 2 }]);
    expect(categoryCounts([o("x", { category: "" })])).toEqual([]);
  });
});
