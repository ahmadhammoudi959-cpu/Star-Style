const de = {
  app: { name: "Star Style", tagline: "Lager · Verkauf · Rechnungen" },
  common: {
    save: "Speichern", cancel: "Abbrechen", back: "Zurück", add: "Hinzufügen", edit: "Bearbeiten",
    delete: "Löschen", search: "Suchen …", actions: "Aktionen", yes: "Ja", no: "Nein", none: "—",
    required: "Pflichtfeld", saved: "Gespeichert", error: "Etwas ist schiefgelaufen", all: "Alle",
    date: "Datum", note: "Notiz", qty: "Menge", total: "Summe", optional: "optional", logout: "Abmelden",
    active: "Aktiv", inactive: "Inaktiv", details: "Details", close: "Schließen", remove: "Entfernen",
    language: "Sprache", nothingYet: "Noch keine Einträge", confirm: "Bestätigen",
  },
  nav: {
    home: "Start", products: "Artikel", receive: "Wareneingang", stock: "Lager", writeOffs: "Verluste",
    suppliers: "Lieferanten", settings: "Einstellungen", sales: "Verkauf", reports: "Berichte", expenses: "Ausgaben",
  },
  home: {
    greeting: "Hallo", subtitle: "Was möchtest du tun?",
    sell: "Verkaufen", sellHint: "Angebot oder Rechnung",
    receive: "Ware eingeben", receiveHint: "Neue Lieferung buchen",
    loss: "Ausgabe / Verlust", lossHint: "Bruch, Ablauf, Kosten",
    reports: "Berichte", reportsHint: "Umsatz & Gewinn",
    stockValue: "Lagerwert", lowStock: "Niedriger Bestand", expiring: "Läuft bald ab", articles: "Artikel",
    alerts: "Hinweise", noAlerts: "Alles in Ordnung – keine Hinweise.", comingSoon: "Folgt in Stufe 2",
  },
  login: {
    title: "Anmelden", email: "E-Mail", password: "Passwort", submit: "Anmelden", invalid: "E-Mail oder Passwort ist falsch.",
  },
  setup: {
    title: "Ersteinrichtung", intro: "Lege dein Konto und die Firmendaten an. Das passiert nur einmal.",
    account: "Dein Konto", name: "Name", company: "Firma", companyName: "Firmenname", vatId: "USt-IdNr.",
    street: "Straße und Nr.", zip: "PLZ", city: "Ort", submit: "Einrichten und starten",
    passwordHint: "Mindestens 10 Zeichen", alreadyDone: "Die Einrichtung ist bereits abgeschlossen.",
  },
  product: {
    title: "Artikel", new: "Neuer Artikel", edit: "Artikel bearbeiten", sku: "Artikelnummer",
    nameDe: "Name (Deutsch)", nameNl: "Name (Niederländisch)", descDe: "Beschreibung (Deutsch)", descNl: "Beschreibung (Niederländisch)",
    category: "Kategorie", supplier: "Lieferant", vat: "MwSt.", purchase: "Einkaufspreis netto", wholesale: "Großhandelspreis netto",
    retail: "Einzelhandelspreis netto", tracksExpiry: "Hat Haltbarkeitsdatum", shops: "Sichtbar in", brandShop: "Marken-Shop",
    generalShop: "Allgemeiner Shop", variants: "Varianten", size: "Größe", color: "Farbe", barcode: "Barcode (EAN)",
    minStock: "Mindestbestand", stock: "Bestand", addVariant: "Variante hinzufügen", noVariantsHint: "Ohne Größe/Farbe einfach eine Zeile leer lassen.",
    skuTaken: "Diese Artikelnummer gibt es schon.", barcodeTaken: "Dieser Barcode ist schon vergeben.", duplicateVariant: "Gleiche Größe/Farbe doppelt.",
    variantHasStock: "Eine Variante mit Bestand kann nicht entfernt werden.", empty: "Noch keine Artikel. Lege den ersten an.", margin: "Marge", reserved: "reserviert", available: "verfügbar",
  },
  receive: {
    title: "Wareneingang", new: "Neue Lieferung", supplier: "Lieferant", supplierInvoice: "Lieferschein-/Rechnungsnr.",
    lines: "Positionen", pickProduct: "Artikel suchen (Name, Nr., Barcode)", unitCost: "EK netto / Stück", batchNo: "Charge",
    expiry: "Haltbar bis", addLine: "Position hinzufügen", submit: "Wareneingang buchen", booked: "Wareneingang gebucht",
    expiryRequired: "Für diesen Artikel ist ein Haltbarkeitsdatum nötig.", history: "Letzte Wareneingänge", number: "Nr.",
    items: "Positionen", value: "Wert",
  },
  stock: {
    title: "Lager", movements: "Bewegungen", value: "Lagerwert (EK)", low: "unter Mindestbestand", filterLow: "Nur niedriger Bestand",
    type: { RECEIPT: "Wareneingang", SALE: "Verkauf", RETURN: "Rückgabe", WRITE_OFF: "Verlust", ADJUSTMENT: "Inventur", CANCEL: "Storno" },
    adjust: "Inventur-Korrektur", counted: "Gezählter Bestand", adjustReason: "Grund", adjusted: "Bestand korrigiert",
    avgCost: "Ø Einkaufspreis", batches: "Chargen", expiresIn: "läuft ab in {d} Tagen", expired: "abgelaufen",
  },
  writeOff: {
    title: "Verluste & Abschreibungen", new: "Verlust erfassen", reason: "Grund",
    reasons: { BREAKAGE: "Bruch", DAMAGE: "Beschädigung", EXPIRED: "Abgelaufen", LOSS: "Verlust / Schwund", OTHER: "Sonstiges" },
    photo: "Foto", submit: "Verlust buchen", booked: "Verlust gebucht", notEnough: "Nicht genug Bestand", protocol: "Protokoll",
    value: "Wert (EK)",
  },
  supplier: {
    title: "Lieferanten", new: "Neuer Lieferant", name: "Name", contact: "Ansprechpartner", email: "E-Mail", phone: "Telefon",
    country: "Land", vatId: "USt-IdNr.", empty: "Noch keine Lieferanten.",
  },
  settings: {
    title: "Einstellungen", company: "Firmendaten", bank: "Bank", invoice: "Rechnungen", owner: "Inhaber",
    taxNumber: "Steuernummer", bankName: "Bank", iban: "IBAN", bic: "BIC", paymentDays: "Zahlungsziel (Tage)",
    offerDays: "Angebot gültig (Tage)", footer: "Fußzeile auf Rechnungen", website: "Webseite",
  },
};
export default de;
export type Dict = typeof de;
