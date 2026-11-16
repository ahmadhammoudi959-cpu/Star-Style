/** @type {import('next').NextConfig} */

// Sicherheits-Kopfzeilen für alle Antworten (die Content-Security-Policy mit Nonce setzt die Middleware)
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }, // 2 Jahre nur HTTPS
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" }, // keine Einbettung in fremde Seiten (Clickjacking)
  { key: "Referrer-Policy", value: "same-origin" },
  // Kamera: Scanner; WhatsApp Web im Rahmen darf Mikrofon (Sprachnachricht), Kamera, Zwischenablage, Vollbild
  { key: "Permissions-Policy", value: 'camera=(self "https://web.whatsapp.com"), microphone=(self "https://web.whatsapp.com"), clipboard-read=(self "https://web.whatsapp.com"), clipboard-write=(self "https://web.whatsapp.com"), fullscreen=(self "https://web.whatsapp.com"), autoplay=(self "https://web.whatsapp.com"), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()' },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }, // internes System: nicht in Suchmaschinen
];

const nextConfig = {
  poweredByHeader: false,
  // Schriften für die PDF-Erzeugung mit ausliefern
  outputFileTracingIncludes: { "/**/*": ["./assets/**/*"] },
  experimental: { serverActions: { bodySizeLimit: "25mb" } }, // E-Mail-Anhänge bis 20 MB (Hostinger: 25 MB)
  // Vorschau im Belegdesign: PDF → Bild auf dem Server (pdf.js + Canvas-Bibliothek mit eigener Binärdatei) – nicht bündeln
  // Postfach (IMAP lesen, E-Mails zerlegen): Node-Pakete mit Logger/Worker – ebenfalls nicht bündeln
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "imapflow", "mailparser"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
export default nextConfig;
