/**
 * Shop-Galerie (Wunsch Inhaber 04.11.2026): eigene Fotos je Shop, das erste ist das Titelbild. Rein und getestet.
 * Grundsatz: Wir fassen im Shop nur Medien an, die wir selbst hochgeladen oder bewusst übernommen haben (media_id gemerkt).
 * Fotos, die jemand im Shop von Hand ergänzt hat, und Fotos der Varianten bleiben unberührt – sie stehen hinter unserer Galerie.
 */

export const GALLERY_MAX = 10;

export type GalleryRow = { id: string; fileId: string; position: number; mediaId: string; removed: boolean };

export type GalleryPlan = {
  /** im Shop löschen (im Formular entfernt) */
  remove: string[];
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
  const remove = [...new Set(tomb.filter((r) => r.mediaId && inStore.has(r.mediaId)).map((r) => r.mediaId))];
  const dropTombstones = tomb.filter((r) => !r.mediaId || !inStore.has(r.mediaId)).map((r) => r.id);
  const lost = live.filter((r) => r.mediaId && !inStore.has(r.mediaId));
  const upload = live.filter((r) => !r.mediaId || !inStore.has(r.mediaId));
  return { remove, upload, lost, dropTombstones };
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

/** Galerie aus dem Formular: nur gültige IDs, ohne Doppelte, höchstens GALLERY_MAX. null = ungültige Eingabe. */
export function parseGalleryInput(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !/^[0-9a-f-]{36}$/i.test(x))) return null;
  return [...new Set(v as string[])].slice(0, GALLERY_MAX);
}

/**
 * Formular → Datenbank: welche Zeilen bleiben (neue Position), welche kommen dazu, welche werden entfernt
 * (mit Medium im Shop → Löschmarke, ohne → Zeile weg).
 */
export function diffGallery(rows: GalleryRow[], wanted: string[]): {
  keep: { id: string; position: number }[]; add: { fileId: string; position: number }[]; tombstone: string[]; drop: string[]; changed: boolean;
} {
  const live = rows.filter((r) => !r.removed).sort((a, b) => a.position - b.position);
  const byFile = new Map<string, GalleryRow>();
  for (const r of live) if (!byFile.has(r.fileId)) byFile.set(r.fileId, r);
  const keep: { id: string; position: number }[] = [], add: { fileId: string; position: number }[] = [];
  wanted.forEach((fileId, position) => {
    const r = byFile.get(fileId);
    if (r) { keep.push({ id: r.id, position }); byFile.delete(fileId); } else add.push({ fileId, position });
  });
  // übrig = entfernt (auch doppelte Zeilen derselben Datei)
  const kept = new Set(keep.map((k) => k.id));
  const gone = live.filter((r) => !kept.has(r.id));
  const tombstone = gone.filter((r) => r.mediaId).map((r) => r.id);
  const drop = gone.filter((r) => !r.mediaId).map((r) => r.id);
  const moved = keep.some((k) => live.find((r) => r.id === k.id)!.position !== k.position);
  return { keep, add, tombstone, drop, changed: Boolean(add.length || tombstone.length || drop.length || moved) };
}
