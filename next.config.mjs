/** @type {import('next').NextConfig} */

// Sicherheits-Kopfzeilen für alle Antworten (die Content-Security-Policy mit Nonce setzt die Middleware)
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }, // 2 Jahre nur HTTPS
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" }, // keine Einbettung in fremde Seiten (Clickjacking)
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }, // internes System: nicht in Suchmaschinen
];

const nextConfig = {
  poweredByHeader: false,
  // Schriften für die PDF-Erzeugung mit ausliefern
  outputFileTracingIncludes: { "/**/*": ["./assets/**/*"] },
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
export default nextConfig;
