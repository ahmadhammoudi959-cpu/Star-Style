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

## Ausbaustufen
- [x] **1 Fundament**: Login/Ersteinrichtung, Artikel (Name DE+NL, Varianten Größe/Farbe, EAN), Lieferanten, Wareneingang mit Charge/MHD, Lager mit Bewegungen, Inventur, Verluste mit Protokoll + Foto, Einstellungen, Dashboard mit Hinweisen.
- [ ] **2 Verkauf**: Kunden (USt-IdNr.-Prüfung VIES + BZSt eVatR), Angebot → Rechnung (eigenes PDF-Design, ZUGFeRD), Lieferschein ohne Preise, Rabatt %, Skonto, Steuerlogik (Inland / Reverse-Charge / USt-IdNr. ausstehend / EU-Privat mit OSS-Schwelle 10.000 € / Export), Storno + Korrektur.
- [ ] **3 Zahlungen**: Teilzahlungen, Ratenplan, Offene Posten mit Ampel, Mahnungen, Kundenkonto, Kreditlimit, Eigentumsvorbehalt.
- [ ] **4 Shop-Anbindung**: zwei Shops (Plattform noch offen), Echtzeit-Bestandsabgleich, Kanal je Verkauf, Abgleich alle 5 Min.
- [ ] **5 Ausgaben & Berichte**: Eingangsrechnungen (Reverse-Charge z. B. Meta/Irland), Kategorien, GuV pro Monat und Kanal, DATEV-Export, Monatspaket für Steuerberater.
- [ ] **6 KI**: Belege auslesen, Nachbestell- und MHD-Hinweise, Monatsbericht in Klartext, Fragen in Alltagssprache.
