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
- Shell: nie `pkill -f` benutzen (beendet die eigene Shell) – Ports mit `fuser -k PORT/tcp` freigeben.
- Beträge in Arabisch: `.num` bekommt in RTL `direction: ltr` (globals.css), damit „-400,00 €“ richtig steht.
- Formulare mit zwei Absende-Knöpfen: Absicht als **kontrolliertes** Hidden-Feld übergeben (`DocEditor`), nicht über name/value am Knopf – sonst geht der Wert verloren.

## Ausbaustufen
- [x] **1 Fundament**: Login/Ersteinrichtung, Artikel (Name DE+NL, Varianten Größe/Farbe, EAN), Lieferanten, Wareneingang mit Charge/MHD, Lager mit Bewegungen, Inventur, Verluste mit Protokoll + Foto, Einstellungen, Dashboard mit Hinweisen.
- [x] **2 Verkauf**: Kunden (USt-IdNr.-Prüfung BZSt eVatR qualifiziert + VIES, Ergebnisse gespeichert), Angebot mit Reservierung → Rechnung, eigenes PDF-Design (pdf-lib) mit eingebetteter E-Rechnung (CII/Factur-X EN16931), Ladeliste ohne Preise mit Unterschriftfeldern, Positions- und Gesamtrabatt, Skonto, Steuerlogik in `src/lib/tax.ts`, Storno (ST-) und „Bearbeiten“ = Korrekturentwurf, der beim Ausstellen die alte Rechnung storniert, E-Mail-Versand per SMTP (optional, `SMTP_*`).
  - Offen: PDF/A-3-Konformität der ZUGFeRD-Datei mit einem Validator prüfen (z. B. Mustang/Validool) – die XML selbst folgt EN16931; OSS-Steuersätze in `EU_STANDARD_RATES_BP` vom Steuerberater bestätigen lassen.
- [x] **3 Zahlungen**: Zahlung bei Ausstellung (voll/Anzahlung), Teilzahlungen (QU-, nie löschen – nur stornieren mit Grund), Ratenplan (Summe = Brutto, Fälligkeit = letzte Rate), Zahlungsstand in `src/lib/payment-status.ts` (rein, getestet; FIFO auf Raten), Offene Posten `/receivables` mit Ampel (rot überfällig, gelb ≤ 7 Tage), Mahnstufen 1–3 (`DUNNING_LEVELS`), Quittung-/Mahnungs-PDF, Kundenkonto `/customers/[id]/statement` (druckbar), Kreditlimit-Warnung im Editor, Dashboard-Kennzahlen, Firmenlogo in Einstellungen.
  - Korrektur einer Rechnung: Zahlungen wandern auf die neue Rechnung (`movePayments`), Ratenplan wird angepasst (`fitPlanToGross`).
  - Rechnungs-PDF zeigt bei Ausstellung erhaltene Zahlungen und den Ratenplan; es wird beim ersten Abruf archiviert und danach nie neu erzeugt.
  - Keine Mahngebühren (Entscheidung Inhaber). Feld `fee_cents` bleibt für später.
- [ ] **4 Shop-Anbindung**: zwei Shops (Plattform noch offen), Echtzeit-Bestandsabgleich, Kanal je Verkauf, Abgleich alle 5 Min.
- [x] **5 Ausgaben & Berichte**: Eingangsrechnungen `/expenses` (Lieferant wird automatisch angelegt, Steuerfall: Inland / EU-Leistung § 13b / Drittland § 13b / innergem. Erwerb / ohne USt, Vorschlag nach Land + Kategorie, Beleg-Upload, Duplikat-Schutz), GuV pro Monat und Kanal `/reports` (Rohertrag = Umsatz − Wareneinsatz aus FEFO-Chargen; Wareneinkauf zählt NICHT als Kosten), Jahresübersicht, USt-Überblick, Monatsmappe `/reports/export` (ZIP: DATEV-Buchungsstapel + Debitoren/Kreditoren, Rechnungs-PDFs, Belege, CSV-Listen, Übersicht-PDF; jede Mappe archiviert in `advisor_exports`), Monatsabschluss (`period_locks`: keine Ausgaben/Zahlungen mehr in abgeschlossenen Monaten), Einstellungen: Berater-/Mandantennummer, SKR03/04, Konten überschreibbar (`/settings/accounts`).
  - DATEV-Format in `src/lib/datev.ts` (EXTF 700, Buchungsstapel v13, Debitoren/Kreditoren v5, Windows-1252, getestet). Konten/Steuerschlüssel in `src/lib/accounts.ts`: Automatikkonten (8400, 8125, 3400, 3425 …) ohne Schlüssel; sonst 9/8 (VSt), 94/91 (§ 13b), 19/18 (Erwerb). Debitor = 10000 + Kundennr., Kreditor = 70000 + Lieferantennr.
  - Offen: einmal mit dem Steuerberater einen Testimport machen und die Kontenzuordnung bestätigen lassen (Kontenrahmen, § 13b-Schlüssel, OSS-Felder). Wareneinkauf aus Drittländern: Einfuhrumsatzsteuer separat erfassen (noch kein eigener Steuerfall).
- [x] **6 KI & Hinweise**:
  - Ohne KI-Dienst (immer aktiv, getestet): `/insights` – Nachbestellen (Verkaufstempo 90 Tage, Reichweite, Bestellmenge, Bestellliste je Lieferant zum Drucken), Ablauf-Risiko nach FEFO (`src/lib/insights.ts`), Ladenhüter; Monatsbericht in Klartext (`src/lib/narrative.ts`) oben in `/reports`.
  - Mit KI (nur wenn `ANTHROPIC_API_KEY` gesetzt, Modell `ANTHROPIC_MODEL`, Standard `claude-sonnet-5-5`): Beleg auslesen im Ausgaben-Formular (Steuerentscheidung trifft `src/lib/ai/receipt-map.ts`, NICHT die KI), `/ask` „Frag dein Geschäft“ mit nur lesenden Werkzeugen (`src/lib/ai/ask.ts`, kein freies SQL, Gespräche nicht gespeichert), ausführlicher Monatsbericht mit Empfehlungen.
  - Zugang über `fetch` (`src/lib/ai/client.ts`), Wiederholung bei 429/529, `ANTHROPIC_BASE_URL` für Tests mit Mock-Server.
