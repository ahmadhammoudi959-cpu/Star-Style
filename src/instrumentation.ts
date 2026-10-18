export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
    const { startWorker } = await import("./lib/shopify/worker");
    startWorker();
  }
}
