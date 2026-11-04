import type { MetadataRoute } from "next";

/** Internes System: Suchmaschinen sollen nichts aufnehmen (zusätzlich X-Robots-Tag in next.config.mjs) */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
