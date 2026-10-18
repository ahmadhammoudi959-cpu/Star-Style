import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { 50: "#eef7f4", 100: "#d5ece4", 500: "#14806a", 600: "#0f6a58", 700: "#0c5547", 900: "#08332b" },
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
