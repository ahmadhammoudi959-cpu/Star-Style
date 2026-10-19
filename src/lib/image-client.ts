/** Foto im Browser verkleinern (max. 1200 px, WebP/JPEG) → schnell hochladen, wenig Speicher. */
export async function shrinkImage(file: File, max = 1200): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("decode")); i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/webp", 0.82));
    const out = blob && blob.type === "image/webp" ? blob : await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (!out) throw new Error("encode");
    return new File([out], file.name.replace(/\.[^.]+$/, "") + (out.type === "image/webp" ? ".webp" : ".jpg"), { type: out.type });
  } finally { URL.revokeObjectURL(url); }
}
