/**
 * Shop-Galerie (Wunsch Inhaber 04.11.2026): eigene Fotos je Shop, das erste ist das Titelbild. Rein und getestet.
 * Grundsatz: Wir fassen im Shop nur Medien an, die wir selbst hochgeladen oder bewusst übernommen haben (media_id gemerkt).
 * Fotos, die jemand im Shop von Hand ergänzt hat, und Fotos der Varianten bleiben unberührt – sie stehen hinter unserer Galerie.
 * Im Shop gelöscht wird nur auf ausdrücklichen Wunsch (Inhaber 04.11.2026): Entfernen eines Fotos, das im Shop ist, fragt
 * „aus System und Shop“ (drop) / „nur aus dem System“ (bleibt im Shop, gilt dann als fremd) / „nur aus dem Shop“ (hidden, bleibt hier).
 */

export const GALLERY_MAX = 10;

export type GalleryRow = { id: string; fileId: string; position: number; mediaId: string; removed: boolean; hidden: boolean };

export type GalleryPlan = {
  /** im Shop löschen: im Formular „aus System und Shop“ entfernt oder „nur aus dem Shop“ genommen */
  remove: string[];
  /** „nur aus dem Shop“ genommen und noch mit Medium → nach dem Löschen media_id leeren (das Foto bleibt bei uns) */
  unlink: string[];
  /** Zeilen ohne Medium im Shop → hochladen (in Galerie-Reihenfolge) */
  upload: GalleryRow[];
  /** Zeilen, deren Medium es im Shop nicht mehr gibt (dort von Hand gelöscht) → neu hochladen; media_id vorher leeren */
  lost: GalleryRow[];
  /** Löschmarken, deren Medium es im Shop schon nicht mehr gibt → nur bei uns entfernen */
  dropTombstones: string[];
};

/** Was ist im Shop zu tun? storeMedia = IDs der Medien des Shop-Produkts in Shop-Reihenfolge. */
export function planGallery(rows: GalleryRow[], storeMedia: string[]): GalleryPlan {
  const inStore = new Set(storeMedia);
  const live = rows.filter((r) => !r.removed).sort((a, b) => a.position - b.position);
  const tomb = rows.filter((r) => r.removed);
  const shown = live.filter((r) => !r.hidden);
  const hiddenWithMedia = live.filter((r) => r.hidden && r.mediaId);
  const remove = [...new Set([...tomb, ...hiddenWithMedia].filter((r) => r.mediaId && inStore.has(r.mediaId)).map((r) => r.mediaId))];
  const dropTombstones = tomb.filter((r) => !r.mediaId || !inStore.has(r.mediaId)).map((r) => r.id);
  const lost = shown.filter((r) => r.mediaId && !inStore.has(r.mediaId));
  const upload = shown.filter((r) => !r.mediaId || !inStore.has(r.mediaId));
  return { remove, unlink: hiddenWithMedia.map((r) => r.id), upload, lost, dropTombstones };
}

/**
 * Verschiebungen (productReorderMedia, Positionen ab 0, nacheinander ausgeführt), damit unsere Galerie vorne in unserer Reihenfolge steht;
 * alle anderen Medien behalten ihre Reihenfolge dahinter. Nur nötige Verschiebungen.
 */
export function reorderMoves(current: string[], gallery: string[]): { id: string; newPosition: string }[] {
  const list = [...current];
  const moves: { id: string; newPosition: string }[] = [];
  gallery.filter((id) => list.includes(id)).forEach((id, i) => {
    const at = list.indexOf(id);
    if (at === i) return;
    list.splice(at, 1);
    list.splice(i, 0, id);
    moves.push({ id, newPosition: String(i) });
  });
  return moves;
}

/** Medien des Shop-Produkts nach dem Löschen und Anhängen neuer Medien (neue kommen hinten an) */
export function afterChanges(current: string[], removed: string[], added: string[]): string[] {
  const gone = new Set(removed);
  return [...current.filter((id) => !gone.has(id)), ...added.filter((id) => !current.includes(id))];
}

/** Neu angehängte Medien = in „nachher“, aber nicht in „vorher“ (Reihenfolge wie nachher = wie hochgeladen) */
export function newMediaIds(before: string[], after: string[]): string[] {
  const old = new Set(before);
  return after.filter((id) => !old.has(id));
}

/**
 * Fotos für ein neues Shop-Produkt: die Galerie dieses Shops (sonst das Lagerfoto), dann eigene Fotos der Varianten – jedes nur einmal.
 */
export function productFiles(gallery: string[], imageFileId: string | null, variantImages: (string | null)[]): string[] {
  const base = gallery.length ? gallery : imageFileId ? [imageFileId] : [];
  return [...new Set([...base, ...variantImages.filter((f): f is string => Boolean(f))])];
}

/**
 * Nach dem Anlegen: Medien kommen in der Reihenfolge der übergebenen Dateien (`sent`). → Galerie-Datei → Medium.
 * Passt die Anzahl nicht (Shopify hat etwas verworfen), wird trotzdem der Reihe nach zugeordnet (sonst kämen die Fotos beim
 * nächsten Abgleich doppelt) – exact = false, dann gibt es einen Hinweis im Protokoll („bitte Fotos im Shop prüfen“).
 */
export function mapCreatedMedia(sent: string[], media: string[], gallery: string[]): { map: Map<string, string>; exact: boolean } {
  const map = new Map<string, string>();
  const want = new Set(gallery);
  sent.forEach((fileId, i) => { if (want.has(fileId) && media[i]) map.set(fileId, media[i]); });
  return { map, exact: media.length === sent.length };
}

/**
 * Galerie aus dem Formular: `files` = Fotos in Galerie-Reihenfolge (auch die „nur aus dem Shop“ genommenen), `hidden` = davon nicht im Shop,
 * `drop` = entfernt mit der Wahl „aus System und Shop“. Entfernte Fotos, die nicht in `drop` stehen, bleiben im Shop.
 */
export type GalleryInput = { files: string[]; hidden: string[]; drop: string[] };

const ids = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) ? [...new Set(v as string[])] : null;

/** Eingabe streng prüfen: nur gültige IDs, ohne Doppelte, höchstens GALLERY_MAX Fotos. null = ungültig. Die frühere Form (nur die Liste) geht auch. */
export function parseGalleryInput(raw: unknown): GalleryInput | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (Array.isArray(v)) { const files = ids(v); return files ? { files: files.slice(0, GALLERY_MAX), hidden: [], drop: [] } : null; }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const files = ids(o.files), hidden = ids(o.hidden ?? []), drop = ids(o.drop ?? []);
  if (!files || !hidden || !drop) return null;
  const list = files.slice(0, GALLERY_MAX);
  return { files: list, hidden: hidden.filter((id) => list.includes(id)), drop: drop.filter((id) => !list.includes(id)).slice(0, 50) };
}

export type GalleryDiff = {
  keep: { id: string; position: number; hidden: boolean }[]; add: { fileId: string; position: number; hidden: boolean }[];
  /** Löschmarke: der Abgleich löscht das Medium im Shop */
  tombstone: string[];
  /** nur bei uns weg, im Shop bleibt das Medium unberührt */
  detach: string[];
  /** ohne Medium im Shop → Zeile weg */
  drop: string[];
  changed: boolean;
};

/**
 * Formular → Datenbank: welche Zeilen bleiben (neue Position, im Shop ja/nein), welche kommen dazu, welche werden entfernt.
 * Entfernt mit Medium im Shop: Löschmarke nur bei der Wahl „aus System und Shop“ (drop), wenn es ohnehin „nur aus dem Shop“
 * genommen war oder bei einer doppelten Zeile derselben Datei – sonst bleibt es im Shop (detach).
 */
export function diffGallery(rows: GalleryRow[], input: GalleryInput): GalleryDiff {
  const live = rows.filter((r) => !r.removed).sort((a, b) => a.position - b.position);
  const byFile = new Map<string, GalleryRow>();
  for (const r of live) if (!byFile.has(r.fileId)) byFile.set(r.fileId, r);
  const hide = new Set(input.hidden);
  const keep: GalleryDiff["keep"] = [], add: GalleryDiff["add"] = [];
  input.files.forEach((fileId, position) => {
    const r = byFile.get(fileId);
    const hidden = hide.has(fileId);
    if (r) { keep.push({ id: r.id, position, hidden }); byFile.delete(fileId); } else add.push({ fileId, position, hidden });
  });
  // übrig = entfernt (auch doppelte Zeilen derselben Datei)
  const kept = new Set(keep.map((k) => k.id));
  const files = new Set(input.files), del = new Set(input.drop);
  const gone = live.filter((r) => !kept.has(r.id));
  const inStoreToo = (r: GalleryRow) => del.has(r.fileId) || r.hidden || files.has(r.fileId);
  const tombstone = gone.filter((r) => r.mediaId && inStoreToo(r)).map((r) => r.id);
  const detach = gone.filter((r) => r.mediaId && !inStoreToo(r)).map((r) => r.id);
  const drop = gone.filter((r) => !r.mediaId).map((r) => r.id);
  const moved = keep.some((k) => { const r = live.find((x) => x.id === k.id)!; return r.position !== k.position || r.hidden !== k.hidden; });
  return { keep, add, tombstone, detach, drop, changed: Boolean(add.length || tombstone.length || detach.length || drop.length || moved) };
}
