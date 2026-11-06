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

describe("Beleg lesen (claude-sonnet-5-5: kein erzwungenes Werkzeug)", () => {
  const raw = {
    is_invoice: true, vendor_name: "SH - Qualitäts-Design GmbH", vendor_country: "DE", vendor_vat_id: "DE462925424",
    invoice_number: "INV-2026-0002", invoice_date: "2026-10-01", currency: "EUR", total_gross: 38689.64, total_net: 32512.3,
    total_vat: 6177.34, vat_rate_percent: 19, reverse_charge: false, is_goods: true, category: "GOODS",
    already_paid: false, payment_method: "UNKNOWN", notes: "",
  };
  const toolUse = { type: "tool_use", id: "t1", name: "record_invoice", input: raw };
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const pdf = Buffer.from("%PDF-1.4 test");
  const body = (f: ReturnType<typeof vi.fn>, i: number) => JSON.parse(f.mock.calls[i][1].body);

  it("tool_choice auto + strict, Denkblock davor stört nicht", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const { readReceipt } = await import("../src/lib/ai/receipt");
    const f = vi.fn().mockResolvedValueOnce(ok({ content: [thinking, toolUse], stop_reason: "tool_use" }));
    const r = await readReceipt(pdf, "application/pdf", { fetchImpl: f as unknown as typeof fetch });
    expect(r.vendorName).toBe("SH - Qualitäts-Design GmbH");
    expect(r.invoiceNo).toBe("INV-2026-0002");
    const b = body(f, 0);
    expect(b.tool_choice).toEqual({ type: "auto" });
    expect(b.tools[0].strict).toBe(true);
    expect(b.tools[0].input_schema.additionalProperties).toBe(false);
    expect(b.max_tokens).toBeGreaterThanOrEqual(4000); // Denken zählt mit
    expect(b.messages[0].content[0].type).toBe("document");
  });
  it("Modell/Gateway kennt strict nicht → noch einmal ohne strict", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const { readReceipt } = await import("../src/lib/ai/receipt");
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('{"type":"error","error":{"type":"invalid_request_error","message":"tools.0.strict: Extra inputs are not permitted"}}', { status: 400 }))
      .mockResolvedValueOnce(ok({ content: [toolUse], stop_reason: "tool_use" }));
    const r = await readReceipt(pdf, "application/pdf", { fetchImpl: f as unknown as typeof fetch });
    expect(r.invoiceNo).toBe("INV-2026-0002");
    expect(f).toHaveBeenCalledTimes(2);
    expect(body(f, 1).tools[0].strict).toBeUndefined();
    expect(body(f, 1).tool_choice).toEqual({ type: "auto" });
  });
  it("antwortet nur mit Text → fragt einmal neu", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const { readReceipt } = await import("../src/lib/ai/receipt");
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ content: [{ type: "text", text: "Das ist eine Rechnung." }], stop_reason: "end_turn" }))
      .mockResolvedValueOnce(ok({ content: [toolUse], stop_reason: "tool_use" }));
    const r = await readReceipt(pdf, "application/pdf", { fetchImpl: f as unknown as typeof fetch });
    expect(r.vendorName).toBe("SH - Qualitäts-Design GmbH");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("andere 400-Fehler werden nicht verschluckt", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const { readReceipt } = await import("../src/lib/ai/receipt");
    const f = vi.fn().mockResolvedValue(new Response('{"error":{"message":"The PDF specified was not valid."}}', { status: 400 }));
    await expect(readReceipt(pdf, "application/pdf", { fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ code: "badRequest" });
    expect(f).toHaveBeenCalledTimes(1);
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
