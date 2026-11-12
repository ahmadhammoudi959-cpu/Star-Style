import { expect, it } from "vitest";
import { EXPIRY_SOON_DAYS, expiryState, parseExpiryFilter, soonUntil } from "../src/lib/expiry";

// MHD: „abgelaufen“ = vor heute, „läuft bald ab“ = heute bis +60 Tage (Startseite, Lagerliste, Chargen)
it("Grenzen: gestern abgelaufen, heute und +60 Tage bald, +61 noch gut", () => {
  expect(EXPIRY_SOON_DAYS).toBe(60);
  expect(expiryState("2026-11-12", "2026-11-11")).toBe("expired");
  expect(expiryState("2026-11-12", "2026-11-12")).toBe("soon"); // am MHD selbst noch gut
  expect(expiryState("2026-11-12", "2027-01-11")).toBe("soon");
  expect(expiryState("2026-11-12", "2027-01-12")).toBe("ok");
  expect(soonUntil("2026-11-12")).toBe("2027-01-11");
  expect(expiryState("2026-11-12", "2025-01-01")).toBe("expired");
});

it("Zeitumstellung und Monatsenden verschieben nichts", () => {
  expect(expiryState("2026-03-28", "2026-03-29")).toBe("soon");
  expect(expiryState("2026-10-26", "2026-10-25")).toBe("expired");
  expect(soonUntil("2026-03-01")).toBe("2026-04-30");
  expect(soonUntil("2028-01-01")).toBe("2028-03-01"); // Schaltjahr
});

it("Filter aus der Adresse (?exp=)", () => {
  expect(parseExpiryFilter("soon")).toBe("soon");
  expect(parseExpiryFilter("expired")).toBe("expired");
  expect(parseExpiryFilter("EXPIRED")).toBeNull();
  expect(parseExpiryFilter("")).toBeNull();
  expect(parseExpiryFilter(undefined)).toBeNull();
});
