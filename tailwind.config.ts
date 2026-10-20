import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Farben aus dem Logo: Blau (Hauptfarbe), Rot (Akzent), Nachtblau (Seitenleiste)
        brand: { 50: "#eef4ff", 100: "#dbe7ff", 200: "#bed3ff", 300: "#90b4fd", 400: "#5b8ef7", 500: "#2f6cf0", 600: "#1752d6", 700: "#1241ae", 800: "#14378b", 900: "#152f6c" },
        accent: { 50: "#fff1f1", 100: "#ffdede", 500: "#e3191c", 600: "#c81316", 700: "#a51215" },
        navy: { 700: "#1a2440", 800: "#111a33", 900: "#0b1222" },
        ink: { DEFAULT: "#1d2433", soft: "#5b6475" },
      },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"] },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,.04), 0 6px 18px rgba(16,24,40,.07)",
        lift: "0 2px 4px rgba(16,24,40,.06), 0 14px 32px rgba(16,24,40,.12)",
      },
      keyframes: {
        rise: { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "none" } },
        wiggle: { "0%,100%": { transform: "rotate(0)" }, "30%": { transform: "rotate(-8deg)" }, "60%": { transform: "rotate(6deg)" } },
      },
      animation: { rise: "rise .35s ease-out both", wiggle: "wiggle .5s ease-in-out" },
    },
  },
  plugins: [],
} satisfies Config;
