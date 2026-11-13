import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildXlsx, colName, excelDate, sheetName, xmlText } from "../src/lib/xlsx";
import { filterCustomerRows, filterQuery, nameIsEmail, readFilter, splitByOrigin, type CustomerRow } from "../src/lib/customer-filter";
import { routeNeed, effectivePerms, PRESETS } from "../src/lib/permissions";

// Kundenliste mit E-Mails als Excel (Wunsch Inhaber 13.11.2026)

describe("Excel-Datei (.xlsx)", () => {
  it("Hilfen: Spaltenbuchstaben, Blattname, Datum, XML", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    expect(sheetName("Kunden: alle [neu]/?*")).toBe("Kunden alle neu");
    expect(sheetName("الزبائن")).toBe("الزبائن");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName(" :/ ")).toBe("Tabelle1");
    expect(excelDate("2024-01-01")).toBe(45292);
    expect(excelDate("1900-03-01")).toBe(61);
    expect(excelDate("2026-02-30")).toBeNull();
    expect(excelDate("13.11.2026")).toBeNull();
    expect(xmlText(`a & <b> "c"\u0001\u0008`)).toBe("a &amp; &lt;b&gt; &quot;c&quot;");
  });

  it("Tabelle: Kopf fett + feststehend, Text bleibt Text (führende Null, =Formel), Zahl, Datum, Arabisch von rechts", async () => {
    const buf = await buildXlsx({
      name: "الزبائن", rtl: true,
      columns: [{ header: "رقم", kind: "int", width: 8 }, { header: "الاسم" }, { header: "الإيميل" }, { header: "PLZ" }, { header: "Seit", kind: "date" }],
      rows: [
        [1, "محمود & Söhne <GmbH>", "a@b.de", "01234", "2026-11-13"],
        [2, "=HYPERLINK(\"http://x\")", "", null, "kaputt"],
      ],
    });
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const wb = await zip.file("xl/workbook.xml")!.async("string");
    expect(sheet).toContain(`<sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`);
    expect(sheet).toContain(`<dimension ref="A1:E3"/>`);
    expect(sheet).toContain(`<autoFilter ref="A1:E3"/>`);
    expect(sheet).toContain(`<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">رقم</t></is></c>`);
    expect(sheet).toContain(`<c r="A2"><v>1</v></c>`);
    expect(sheet).toContain(`<t xml:space="preserve">محمود &amp; Söhne &lt;GmbH&gt;</t>`);
    expect(sheet).toContain(`<c r="D2" t="inlineStr"><is><t xml:space="preserve">01234</t></is></c>`);
    expect(sheet).toContain(`<c r="E2" s="2"><v>${excelDate("2026-11-13")}</v></c>`);
    // nie eine Formel: kein <f>, der Text steht als Text da
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain(`<t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t>`);
    // leere Zellen fallen weg, ungültiges Datum bleibt als Text sichtbar
    expect(sheet).not.toContain(`r="C3"`);
    expect(sheet).not.toContain(`r="D3"`);
    expect(sheet).toContain(`<c r="E3" t="inlineStr"><is><t xml:space="preserve">kaputt</t></is></c>`);
    expect(wb).toContain(`<sheet name="الزبائن" sheetId="1" r:id="rId1"/>`);
    expect(wb).toContain(`'الزبائن'!$A$1:$E$3`);
    // ohne RTL kein rightToLeft
    const ltr = await JSZip.loadAsync(await buildXlsx({ name: "Kunden", columns: [{ header: "A" }], rows: [] }));
    expect(await ltr.file("xl/worksheets/sheet1.xml")!.async("string")).toContain(`<sheetView workbookViewId="0">`);
  });
});

const row = (p: Partial<CustomerRow>): CustomerRow => ({
  id: "x", number: 1, type: "COMPANY", name: "Salon Kaya", contact: "", email: "", phone: "", street: "", zip: "", city: "", country: "DE",
  vatId: "", group: "RETAIL", mode: "DOMESTIC", fromShop: null, shops: [], isNew: false, createdDay: "2026-11-13", ...p,
});

describe("Kundenliste: Filter (gleich für Seite und Excel)", () => {
  const rows = [
    // im System angelegt, später im allgemeinen Shop angemeldet (Großhandel)
    row({ id: "1", number: 1, name: "محمود", group: "WHOLESALE", city: "Frankfurt", vatId: "DE597715435", shops: ["GENERAL_SHOP"] }),
    row({ id: "2", number: 2, name: "Sulaiman Ahmad", email: "sul@example.com", city: "Herne", fromShop: "GENERAL_SHOP", shops: ["GENERAL_SHOP"], isNew: true }),
    row({ id: "3", number: 3, name: "Ahmad@Example.com", email: "ahmad@example.com", fromShop: "BRAND_SHOP", shops: ["BRAND_SHOP"], isNew: true }),
    row({ id: "4", number: 4, name: "Salon Nord", email: "nord@salon.de", city: "Herne" }),
  ];
  const ids = (f: Parameters<typeof filterCustomerRows>[1]) => filterCustomerRows(rows, f).map((r) => r.id);
  it("Herkunft: im System angelegt / aus den Shops getrennt – ein später im Shop angemeldeter Systemkunde bleibt beim System", () => {
    expect(ids({ src: "system" })).toEqual(["1", "4"]);
    expect(ids({ src: "shops" })).toEqual(["2", "3"]);
    expect(ids({ src: "GENERAL_SHOP" })).toEqual(["2"]);
    expect(ids({ src: "BRAND_SHOP" })).toEqual(["3"]);
    const sp = splitByOrigin(rows);
    expect([sp.system.map((r) => r.id), sp.shops.map((r) => r.id)]).toEqual([["1", "4"], ["2", "3"]]);
  });
  it("Suche (Name, Ort, USt-IdNr., E-Mail, Kd.-Nr.), Ort, Preisgruppe, Herkunft", () => {
    expect(ids({})).toEqual(["1", "2", "3", "4"]);
    expect(ids({ q: "SUL@" })).toEqual(["2"]);
    expect(ids({ q: "2" })).toEqual(["2"]);
    expect(ids({ q: "de5977" })).toEqual(["1"]);
    expect(ids({ city: "Herne" })).toEqual(["2", "4"]);
    expect(ids({ group: "WHOLESALE" })).toEqual(["1"]);
    expect(ids({ src: "shop" })).toEqual(["1", "2", "3"]); // ältere Links: mit Shop-Konto/-Bestellung, egal woher
    expect(ids({ src: "new" })).toEqual(["2", "3"]);
    expect(ids({ src: "shops", city: "Herne" })).toEqual(["2"]);
    expect(ids({ src: "unbekannt" })).toEqual(["1", "2", "3", "4"]);
  });
  it("Name = E-Mail ist nur ein Platzhalter; Filter aus der Adresszeile begrenzt; Adresszeile nur mit gesetzten Filtern", () => {
    expect(rows.map(nameIsEmail)).toEqual([false, false, true, false]);
    expect(nameIsEmail(row({ name: " ", email: "" }))).toBe(true);
    const f = readFilter((k) => ({ q: "x".repeat(300), group: "WHOLESALE", other: "y" } as Record<string, string>)[k]);
    expect(f.q).toHaveLength(200);
    expect(f).toEqual({ q: "x".repeat(200), city: "", tax: "", group: "WHOLESALE", src: "" });
    expect(filterQuery({ q: " ", group: "WHOLESALE", src: "new" })).toBe("group=WHOLESALE&src=new");
    expect(filterQuery({})).toBe("");
  });
});

describe("Recht „Kundenliste als Excel“", () => {
  it("eigenes Recht (nicht schon mit „Kunden“), bringt „Kunden“ mit; Vorlagen ohne", () => {
    expect(routeNeed("/api/customers/export")).toEqual({ any: ["customers.export"] });
    expect(effectivePerms(["customers"], false).has("customers.export")).toBe(false);
    expect(effectivePerms(["customers.export"], false).has("customers")).toBe(true);
    for (const p of Object.values(PRESETS)) expect(p).not.toContain("customers.export");
  });
});
