import { afterEach, describe, expect, it, vi } from "vitest";
import { callClaude, AiError } from "../src/lib/ai/client";
import { ask, runTool, TOOLS } from "../src/lib/ai/ask";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

describe("KI-Zugang", () => {
  it("ohne Schlüssel: klarer Fehler, kein Netzwerk", async () => {
    await expect(callClaude({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "notConfigured" });
  });
  it("wiederholt bei Überlastung, sendet Version und Modell", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 529 }))
      .mockResolvedValueOnce(ok({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }));
    const r = await callClaude({ messages: [{ role: "user", content: "x" }] }, { fetchImpl: f as unknown as typeof fetch });
    expect(r.content[0]).toEqual({ type: "text", text: "hi" });
    expect(f).toHaveBeenCalledTimes(2);
    const [, init] = f.mock.calls[1];
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(init.body).model).toBe("claude-sonnet-5-5");
  });
  it("ungültiger Schlüssel: sofort Fehler ohne Wiederholung", async () => {
    process.env.ANTHROPIC_API_KEY = "bad";
    const f = vi.fn().mockResolvedValue(new Response("no", { status: 401 }));
    await expect(callClaude({ messages: [{ role: "user", content: "x" }] }, { fetchImpl: f as unknown as typeof fetch })).rejects.toBeInstanceOf(AiError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("Werkzeuge sind nur lesend und vollständig beschrieben", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["month_report", "year_report", "product_sales", "customer_sales", "customer_account", "stock_lookup", "open_receivables", "expenses", "stock_insights"]);
    for (const t of TOOLS) expect(t.input_schema.type).toBe("object");
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Frag dein Geschäft (Datenbank, KI simuliert)", () => {
  it("Werkzeuge liefern Daten in Euro", async () => {
    const m = (await runTool("month_report", { month: new Date().toISOString().slice(0, 7) })) as { totals: Record<string, unknown> };
    expect(typeof m.totals.revenueNet).toBe("number");
    expect(Array.isArray(await runTool("stock_lookup", { query: "a" }))).toBe(true);
    expect(await runTool("product_sales", { from: "2026-01-01", to: "2026-12-31", sort: "profit", limit: 3 })).toHaveProperty("products");
    expect(await runTool("open_receivables", {})).toHaveProperty("totalOpen");
    expect(await runTool("stock_insights", {})).toHaveProperty("reorder");
    await expect(runTool("drop_table", {})).rejects.toThrow();
  });
  it("Ablauf: KI ruft Werkzeug, bekommt Ergebnis, antwortet", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ content: [{ type: "tool_use", id: "t1", name: "open_receivables", input: {} }], stop_reason: "tool_use" }))
      .mockResolvedValueOnce(ok({ content: [{ type: "text", text: "Salon Raten schuldet am meisten." }], stop_reason: "end_turn" }));
    vi.stubGlobal("fetch", f);
    const r = await ask([{ role: "user", text: "Wer schuldet mir am meisten?" }], "de", "Start Style");
    expect(r).toEqual({ answer: "Salon Raten schuldet am meisten.", used: ["open_receivables"] });
    const second = JSON.parse(f.mock.calls[1][1].body);
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(second.system).toContain("German");
  });
});
