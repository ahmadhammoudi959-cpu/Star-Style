import { z } from "zod";
import { db, schema } from "@/db";
import { apiDenied, getAuth } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { aiConfigured, AiError } from "@/lib/ai/client";
import { agentStep, type AgentRequest } from "@/lib/ai/agent";
import { LIMITS } from "@/lib/agent/protocol";

export const dynamic = "force-dynamic";

/**
 * Assistent „Star Style“ (Wunsch Inhaber 17.11.2026): nimmt die Bitte bzw. das Ergebnis der letzten Schritte + eine
 * Text-Ansicht der Seite entgegen und gibt die nächste Anweisung zurück. Ausgeführt wird im Browser über die normalen
 * Knöpfe (Rechte wie immer). Recht „assistant“.
 */
const el = z.object({
  id: z.string().regex(/^e\d{1,4}$/), kind: z.enum(["button", "link", "input", "textarea", "select", "checkbox", "radio", "option", "password", "file", "other"]),
  name: z.string().max(300), value: z.string().max(600).optional(), checked: z.boolean().optional(), disabled: z.boolean().optional(),
  options: z.array(z.string().max(120)).max(80).optional(), href: z.string().max(400).optional(), submit: z.boolean().optional(), blocked: z.boolean().optional(),
});
const snapshot = z.object({ url: z.string().max(500), title: z.string().max(300), dialog: z.string().max(300).optional(), elements: z.array(el).max(LIMITS.elements + 200), text: z.string().max(12_000) });
const runId = z.string().uuid();
const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), goal: z.string().trim().min(1).max(2000), snapshot }),
  z.object({ kind: z.literal("continue"), runId, results: z.array(z.object({ i: z.number().int(), ok: z.boolean(), note: z.string().max(500).optional() })).max(30), note: z.string().max(2000).optional(), snapshot }),
  z.object({ kind: z.literal("answer"), runId, answer: z.string().max(2000), approve: z.enum(["auto", "step", "no"]).optional(), snapshot }),
  z.object({ kind: z.literal("cancel"), runId }),
]);

export async function POST(req: Request) {
  const denied = await apiDenied("assistant");
  if (denied) return denied;
  if (!aiConfigured()) return Response.json({ error: "notConfigured" }, { status: 503 });
  const a = (await getAuth())!;
  const raw = await req.text();
  if (raw.length > 400_000) return Response.json({ error: "tooLarge" }, { status: 413 });
  let parsed: z.infer<typeof body>;
  try { parsed = body.parse(JSON.parse(raw)); } catch { return Response.json({ error: "bad" }, { status: 400 }); }
  const { locale } = await getI18n();
  const company = (await db.query.companySettings.findFirst({ columns: { name: true } }))?.name ?? "";
  try {
    const out = await agentStep(parsed as AgentRequest, { access: a, userId: a.uid, userName: a.name, locale, company });
    // nachvollziehbar: wer hat was beauftragt / freigegeben (die Änderungen selbst protokollieren die Seiten wie immer)
    if (parsed.kind === "start") await db.insert(schema.auditLog).values({ entity: "assistant", entityId: out.runId, action: "start", userId: a.uid, after: { goal: parsed.goal } });
    if (parsed.kind === "answer" && parsed.approve && parsed.approve !== "no") await db.insert(schema.auditLog).values({ entity: "assistant", entityId: out.runId, action: "approve", userId: a.uid, after: { mode: parsed.approve } });
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const code = e instanceof AiError ? e.code : "error";
    console.error("assistant", e);
    return Response.json({ error: code }, { status: 502 });
  }
}
