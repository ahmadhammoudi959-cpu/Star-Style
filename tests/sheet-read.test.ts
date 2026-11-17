import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import sharp from "sharp";
import { decodeText, numberText, parseCsv, readWorkbook, serialToIso, SheetError } from "../src/lib/sheet-read";

/** kleine, echte PNGs zum Einbetten */
const png = (r: number, g: number, b: number) => sharp({ create: { width: 4, height: 4, channels: 3, background: { r, g, b } } }).png().toBuffer();

/**
 * Excel-Datei wie aus Excel 365: geteilte Texte mit Formatierung, Inline-Text, Barcode als Zahl (auch mit Exponent),
 * Datum, Kommazahl, verstecktes Blatt, ein Bild über Zeile 3 (Zeichnung) und ein Bild IN Zelle F4 (Rich Value).
 */
async function workbook(): Promise<Uint8Array> {
  const z = new JSZip();
  z.file("[Content_Types].xml", "<Types/>");
  z.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet name="Artikel" sheetId="1" r:id="rId1"/><sheet name="Geheim" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`);
  z.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`);
  z.file("xl/sharedStrings.xml", `<sst><si><t>Name</t></si><si><t>Barcode</t></si><si><r><rPr><b/></rPr><t>Preis</t></r><r><t xml:space="preserve"> €</t></r></si><si><t>Haarwachs &amp; Gel &lt;stark&gt;</t><rPh><t>X</t></rPh></si><si><t>MHD</t></si><si><t>Foto</t></si><si><t>Zeile_x000D_neu</t></si></sst>`);
  z.file("xl/styles.xml", `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>`);
  z.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>
    <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>4006381333931</v></c><c r="C3" s="2"><v>12.500000000000002</v></c><c r="D3" s="1"><v>46387</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Schere &quot;Profi&quot;</t></is></c><c r="B4"><v>4.0063813339310E+12</v></c><c r="C4" t="str"><f>1+1</f><v>2</v></c><c r="E4" t="b"><v>1</v></c><c r="F4" t="e" vm="1"><v>#VALUE!</v></c></row>
    <row r="5"><c r="A5" t="s"><v>6</v></c><c r="B5"/></row>
    <row r="7"/>
  </sheetData><drawing r:id="rId1"/></worksheet>`);
  z.file("xl/worksheets/_rels/sheet1.xml.rels", `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  z.file("xl/drawings/drawing1.xml", `<xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:r="r"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>5</xdr:col><xdr:colOff>1</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>5</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:row>3</xdr:row></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="rId7" cstate="print"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor><xdr:oneCellAnchor><xdr:from><xdr:col>9</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rId8"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>`);
  z.file("xl/drawings/_rels/drawing1.xml.rels", `<Relationships><Relationship Id="rId7" Type="image" Target="../media/image1.png"/><Relationship Id="rId8" Type="image" Target="../media/logo.emf"/></Relationships>`);
  z.file("xl/media/image1.png", await png(255, 0, 0));
  z.file("xl/media/logo.emf", Buffer.from("emf"));
  z.file("xl/media/image2.png", await png(0, 0, 255));
  // Bild in Zelle F4 (vm="1")
  z.file("xl/metadata.xml", `<metadata><metadataTypes count="2"><metadataType name="XLDAPR"/><metadataType name="XLRICHVALUE"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{3e2802c4}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata><valueMetadata count="1"><bk><rc t="2" v="0"/></bk></valueMetadata></metadata>`);
  z.file("xl/richData/rdrichvaluestructure.xml", `<rvStructures count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>`);
  z.file("xl/richData/rdrichvalue.xml", `<rvData count="1"><rv s="0"><v>0</v><v>5</v></rv></rvData>`);
  z.file("xl/richData/richValueRel.xml", `<richValueRels xmlns:r="r"><rel r:id="rId1"/></richValueRels>`);
  z.file("xl/richData/_rels/richValueRel.xml.rels", `<Relationships><Relationship Id="rId1" Type="image" Target="../media/image2.png"/></Relationships>`);
  z.file("xl/worksheets/sheet2.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>geheim</t></is></c></row></sheetData></worksheet>`);
  return z.generateAsync({ type: "uint8array" });
}

describe("Tabellen lesen: Excel", () => {
  it("Texte, Zahlen ohne Exponent, Datum, Lücken und Bilder mit ihrer Zeile", async () => {
    const wb = await readWorkbook(await workbook(), "liste.xlsx");
    expect(wb.sheets.map((s) => s.name)).toEqual(["Artikel"]); // verstecktes Blatt nicht
    const { rows, images } = wb.sheets[0];
    expect(rows[0]).toEqual(["Name", "Barcode", "Preis €", "MHD", "", "Foto"]);
    expect(rows[1]).toEqual([]); // leere Zeile 2 bleibt stehen
    expect(rows[2]).toEqual(["Haarwachs & Gel <stark>", "4006381333931", "12.5", "2026-12-31"]);
    expect(rows[3]).toEqual(['Schere "Profi"', "4006381333931", "2", "", "TRUE", ""]);
    expect(rows[4]).toEqual(["Zeile\rneu", ""]);
    expect(rows.length).toBe(5); // leere Zeilen am Ende weg
    expect(images.map((i) => [i.row, i.col, i.mime, i.data.length > 50])).toEqual([[2, 5, "image/png", true], [3, 5, "image/png", true]]); // EMF nicht
    expect((await sharp(Buffer.from(images[1].data)).raw().toBuffer())[2]).toBe(255); // blaues Bild in Zelle F4
  });

  it("alte .xls und andere Dateien klar ablehnen", async () => {
    await expect(readWorkbook(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "alt.xls")).rejects.toMatchObject({ code: "fileXls" });
    await expect(readWorkbook(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "x.pdf")).rejects.toBeInstanceOf(SheetError);
    const z = new JSZip(); z.file("word/document.xml", "<w/>");
    await expect(readWorkbook(await z.generateAsync({ type: "uint8array" }), "brief.docx")).rejects.toMatchObject({ code: "fileType" });
  });

  it("Zahlen und Datum", () => {
    expect(numberText("4.006381333931E+12")).toBe("4006381333931");
    expect(numberText("40063813339312")).toBe("40063813339312");
    expect(numberText("0.1")).toBe("0.1");
    expect(numberText("29.899999999999999")).toBe("29.9");
    expect(serialToIso(46387)).toBe("2026-12-31");
    expect(serialToIso(1, true)).toBe("1904-01-02");
  });
});

describe("Tabellen lesen: CSV", () => {
  it("Semikolon, Anführungszeichen, Zeilenumbruch im Feld, BOM", async () => {
    const text = "﻿Name;Preis;Notiz\r\n\"Kamm; schwarz\";4,95;\"sagt \"\"hallo\"\"\nzweite Zeile\"\r\n\r\nSchere;12,00;\r\n";
    const wb = await readWorkbook(new TextEncoder().encode(text), "liste.csv");
    expect(wb.sheets[0].rows).toEqual([["Name", "Preis", "Notiz"], ["Kamm; schwarz", "4,95", 'sagt "hallo"\nzweite Zeile'], [""], ["Schere", "12,00", ""]]);
  });
  it("Komma und Tab als Trennzeichen", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a\tb\n1\t2,5")).toEqual([["a", "b"], ["1", "2,5"]]);
  });
  it("Windows-1252 (Excel unter Windows) und UTF-16 (Unicode-Text)", () => {
    expect(decodeText(new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65]))).toBe("Größe");
    const u16 = new Uint8Array([0xff, 0xfe, ...Array.from(Buffer.from("اسم\tسعر", "utf16le"))]);
    expect(parseCsv(decodeText(u16))).toEqual([["اسم", "سعر"]]);
  });
});
