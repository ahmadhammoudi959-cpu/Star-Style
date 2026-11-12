/** E-Mail für die Verbindung Kunde ↔ Shop (klein geschrieben, ohne Leerzeichen) – rein, auch im Browser benutzt */
export const normEmail = (e: string) => e.trim().toLowerCase();
export const validEmail = (e: string) => /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]{2,}$/.test(e.trim());
