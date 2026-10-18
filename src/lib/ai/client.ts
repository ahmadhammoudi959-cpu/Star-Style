import "server-only";
/**
 * Zugang zum KI-Dienst (Claude API von Anthropic). Ohne ANTHROPIC_API_KEY sind alle KI-Funktionen ausgeblendet –
 * das System läuft dann vollständig ohne KI weiter.
 * Datenschutz: Belege und Kennzahlen werden nur bei aktiver Nutzung übertragen; Gespräche werden nicht gespeichert.
 */
export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);
export const aiModel = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Message = { role: "user" | "assistant"; content: string | ContentBlock[] };
export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
export type AiResponse = { content: ContentBlock[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };

export class AiError extends Error {
  constructor(public code: "notConfigured" | "rateLimit" | "overloaded" | "badRequest" | "auth" | "network" | "timeout", detail?: string) { super(detail ?? code); }
}

/** Ein Aufruf der Messages-API mit Wiederholung bei Überlastung (429/529) und Zeitlimit. */
export async function callClaude(req: { system?: string; messages: Message[]; tools?: Tool[]; tool_choice?: Record<string, unknown>; max_tokens?: number }, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<AiResponse> {
  if (!aiConfigured()) throw new AiError("notConfigured");
  const f = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ model: aiModel(), max_tokens: req.max_tokens ?? 2048, system: req.system, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice });
  let last: AiError = new AiError("network");
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await f(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
        method: "POST", signal: ctrl.signal, body,
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      });
      if (res.ok) return (await res.json()) as AiResponse;
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) throw new AiError("auth", text);
      if (res.status === 400) throw new AiError("badRequest", text);
      last = new AiError(res.status === 429 ? "rateLimit" : "overloaded", text);
    } catch (e) {
      if (e instanceof AiError && (e.code === "auth" || e.code === "badRequest")) throw e;
      last = e instanceof AiError ? e : (e as Error).name === "AbortError" ? new AiError("timeout") : new AiError("network", String(e));
    } finally { clearTimeout(timer); }
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  throw last;
}
