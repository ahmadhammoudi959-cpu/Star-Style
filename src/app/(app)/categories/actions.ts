"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { addCategoryToStore, CategoryError, createCategory, deleteCategory, moveProductToCategory, type MoveResult } from "@/lib/categories";
import { encodeStoreResults } from "@/lib/shopify/category-map";
import type { StoreCategoryResult } from "@/lib/shopify/collections";
import type { ShopChannel } from "@/lib/shopify/client";

export type CatState = { error?: string; values?: { name: string } } | undefined;

const CHANNELS = ["BRAND_SHOP", "GENERAL_SHOP"] as const;
const isChannel = (c: unknown): c is ShopChannel => c === "BRAND_SHOP" || c === "GENERAL_SHOP";
/** Menü-Auswahl aus dem Formular: "-" oder fehlt = nicht ins Menü, sonst ID der Gruppe */
const group = (v: FormDataEntryValue | null) => (v == null || v === "-" ? null : /^gid:\/\/shopify\/MenuItem\/\d+$/.test(String(v)) ? String(v) : null);

function refresh() {
  revalidatePath("/categories", "layout");
  revalidatePath("/products", "layout");
  revalidatePath("/shops", "layout");
}

/** Neue Kategorie – auf Wunsch gleich in den angehakten Shops (Kollektion, veröffentlicht, ggf. ins Menü) */
export async function createCategoryAction(_: CatState, fd: FormData): Promise<CatState> {
  const session = await requireSession();
  const name = String(fd.get("name") ?? "");
  const channels = CHANNELS.filter((c) => fd.get(`in_${c}`) === "on");
  const groups = Object.fromEntries(channels.map((c) => [c, group(fd.get(`group_${c}`))]));
  let r: Awaited<ReturnType<typeof createCategory>>;
  try {
    r = await createCategory({ name, channels, groups }, session.uid);
  } catch (e) {
    if (e instanceof CategoryError) return { error: e.code, values: { name } };
    console.error(e);
    return { error: "error", values: { name } };
  }
  refresh();
  redirect(`/categories/${r.id}?created=1${r.results.length ? `&r=${encodeURIComponent(encodeStoreResults(r.results.map(code)))}` : ""}`);
}

const code = (x: StoreCategoryResult) => ({ channel: x.channel, outcome: x.outcome, ...(x.menu ? { menu: x.menu } : {}) });

/** Kategorie nachträglich in einem Shop anlegen */
export async function addToStoreAction(categoryId: string, channel: string, groupId: string | null) {
  const session = await requireSession();
  if (!isChannel(channel) || typeof categoryId !== "string") return null;
  try {
    const r = await addCategoryToStore(categoryId, channel, group(groupId ?? "-"), session.uid);
    refresh();
    return code(r);
  } catch (e) {
    console.error(e);
    return { channel, outcome: "failed" as const };
  }
}

export type MoveState = { ok: true; r: MoveResult } | { ok: false; error: string };

/** Artikel in diese Kategorie (oder eine andere / ohne) – im Shop wandert er mit */
export async function moveProductAction(productId: string, categoryId: string | null): Promise<MoveState> {
  const session = await requireSession();
  if (typeof productId !== "string" || (categoryId !== null && typeof categoryId !== "string")) return { ok: false, error: "error" };
  try {
    const r = await moveProductToCategory(productId, categoryId, session.uid);
    refresh();
    return { ok: true, r };
  } catch (e) {
    if (e instanceof CategoryError) return { ok: false, error: e.code };
    console.error(e);
    return { ok: false, error: "error" };
  }
}

/** Leere Kategorie löschen (im Shop nur unsere eigene, leere Kollektion) */
export async function deleteCategoryAction(_: CatState, fd: FormData): Promise<CatState> {
  const session = await requireSession();
  let name = "";
  try {
    name = (await deleteCategory(String(fd.get("id") ?? ""), session.uid)).name;
  } catch (e) {
    if (e instanceof CategoryError) return { error: e.code };
    console.error(e);
    return { error: "error" };
  }
  refresh();
  redirect(`/categories?deleted=${encodeURIComponent(name)}`);
}
