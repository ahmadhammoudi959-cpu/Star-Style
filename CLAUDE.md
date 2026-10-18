# Star Style – Warenwirtschaft, Rechnungen, Zahlungen

Internes System für **eine** Firma (Friseurbedarf-Großhandel). Kein SaaS, keine Mandanten.
Vollständige Anforderungen: `docs/plan.pdf` (Arabisch). Kurzfassung unten.

## Stack
Next.js 15 (App Router, Server Actions) · TypeScript strict · Drizzle ORM + PostgreSQL 16 · Tailwind 3 · Hosting: Render, Region Frankfurt.

## Befehle
- `npm run dev` – Entwicklung (braucht `.env`, siehe `.env.example`)
- `npm run db:generate` – Migration aus `src/db/schema.ts` erzeugen (nie Migrationen von Hand ändern, die schon deployed sind)
- `npm run db:migrate` – Migrationen anwenden
- `npm test` – Unit- und Integrationstests (Integration braucht `DATABASE_URL`)
- `npm run typecheck`, `npm run build`

## Unverhandelbare Regeln
1. **Geld = Integer-Cent**, Prozent = Basispunkte (1900 = 19 %). Nie Floats speichern.
2. **Bestand nie direkt setzen.** Jede Änderung läuft über `src/lib/stock.ts` (`addStock`, `removeStock`, `bookMovement`) in einer Transaktion. `variants.stock_qty` ist nur ein Cache der Summe aller `stock_movements`.
3. **Abgang nach FEFO** (zuerst ablaufende Charge). Wareneinsatz = EK der verbrauchten Charge.
4. **Belegnummern lückenlos** über `nextNumber()` in derselben Transaktion wie der Beleg.
5. **Ausgestellte Rechnungen werden nie geändert oder gelöscht.** „Bearbeiten“ einer ausgestellten Rechnung = automatisch Stornorechnung + neue korrigierte Rechnung (GoBD). Für den Nutzer ist es ein normaler Bearbeiten-Knopf.
6. Jede fachliche Änderung schreibt `audit_log`.
7. UI dreisprachig (de/ar/en, Arabisch = RTL). Texte nur über `src/i18n/*.ts`. Zahlen/Datum immer im deutschen Format.
8. Gestaltung: jede Karte hat Schatten und leichte Bewegung, Icons animiert beim Hover (`.card`, `.card-hover`, `.icon-pop`).
9. Sehr einfache Bedienung: ein Nutzer, wenig Vorkenntnisse. Max. 3 Schritte pro Vorgang, klare Fehlermeldungen in seiner Sprache.

## Bekannte Punkte
- `npm audit`: verbleibend nur `postcss` innerhalb von Next (Build-Zeit, verarbeitet nur eigenes CSS) – beim nächsten Next-Update erneut prüfen.
- Formulare mit zwei Absende-Knöpfen: Absicht als **kontrolliertes** Hidden-Feld übergeben (`DocEditor`), nicht über name/value am Knopf – sonst geht der Wert verloren.

## Ausbaustufen
- [x] **1 Fundament**: Login/Ersteinrichtung, Artikel (Name DE+NL, Varianten Größe/Farbe, EAN), Lieferanten, Wareneingang mit Charge/MHD, Lager mit Bewegungen, Inventur, Verluste mit Protokoll + Foto, Einstellungen, Dashboard mit Hinweisen.
- [x] **2 Verkauf**: Kunden (USt-IdNr.-Prüfung BZSt eVatR qualifiziert + VIES, Ergebnisse gespeichert), Angebot mit Reservierung → Rechnung, eigenes PDF-Design (pdf-lib) mit eingebetteter E-Rechnung (CII/Factur-X EN16931), Ladeliste ohne Preise mit Unterschriftfeldern, Positions- und Gesamtrabatt, Skonto, Steuerlogik in `src/lib/tax.ts`, Storno (ST-) und „Bearbeiten“ = Korrekturentwurf, der beim Ausstellen die alte Rechnung storniert, E-Mail-Versand per SMTP (optional, `SMTP_*`).
  - Offen: PDF/A-3-Konformität der ZUGFeRD-Datei mit einem Validator prüfen (z. B. Mustang/Validool) – die XML selbst folgt EN16931; OSS-Steuersätze in `EU_STANDARD_RATES_BP` vom Steuerberater bestätigen lassen.
- [x] **3 Zahlungen**: Zahlung bei Ausstellung (voll/Anzahlung), Teilzahlungen (QU-, nie löschen – nur stornieren mit Grund), Ratenplan (Summe = Brutto, Fälligkeit = letzte Rate), Zahlungsstand in `src/lib/payment-status.ts` (rein, getestet; FIFO auf Raten), Offene Posten `/receivables` mit Ampel (rot überfällig, gelb ≤ 7 Tage), Mahnstufen 1–3 (`DUNNING_LEVELS`), Quittung-/Mahnungs-PDF, Kundenkonto `/customers/[id]/statement` (druckbar), Kreditlimit-Warnung im Editor, Dashboard-Kennzahlen, Firmenlogo in Einstellungen.
  - Korrektur einer Rechnung: Zahlungen wandern auf die neue Rechnung (`movePayments`), Ratenplan wird angepasst (`fitPlanToGross`).
  - Rechnungs-PDF zeigt bei Ausstellung erhaltene Zahlungen und den Ratenplan; es wird beim ersten Abruf archiviert und danach nie neu erzeugt.
  - Mahngebühr 5 € ab 2. Mahnung – vom Steuerberater/Inhaber bestätigen lassen.
- [ ] **4 Shop-Anbindung**: zwei Shops (Plattform noch offen), Echtzeit-Bestandsabgleich, Kanal je Verkauf, Abgleich alle 5 Min.
- [ ] **5 Ausgaben & Berichte**: Eingangsrechnungen (Reverse-Charge z. B. Meta/Irland), Kategorien, GuV pro Monat und Kanal, DATEV-Export, Monatspaket für Steuerberater.
- [ ] **6 KI**: Belege auslesen, Nachbestell- und MHD-Hinweise, Monatsbericht in Klartext, Fragen in Alltagssprache.
