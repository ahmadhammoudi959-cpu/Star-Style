"use server";
import { requireSession } from "@/lib/auth";
import { lookupCode, type ScanResult } from "@/lib/scan";

/** Barcode/Art.-Nr. nachschlagen – nur lesen, keine Änderung */
export async function scanLookupAction(code: string): Promise<ScanResult> {
  await requireSession();
  return lookupCode(String(code ?? ""));
}
