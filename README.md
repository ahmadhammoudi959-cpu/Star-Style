# Star Style

Lager, Verkauf, Rechnungen und Zahlungen für Start Style Friseurbedarf.

## Lokal starten
```bash
cp .env.example .env        # DATABASE_URL und SESSION_SECRET eintragen
npm install
npm run db:migrate
npm run dev                 # http://localhost:3000 → Ersteinrichtung
```

## Deployment (Render)
Repository verbinden → „New Blueprint“ → `render.yaml` wird erkannt (Region Frankfurt).
Migrationen laufen automatisch vor jedem Deploy.

Projektregeln und Ausbaustufen: siehe `CLAUDE.md`.
