/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Schriften für die PDF-Erzeugung mit ausliefern
  outputFileTracingIncludes: { "/**/*": ["./assets/**/*"] },
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
};
export default nextConfig;
