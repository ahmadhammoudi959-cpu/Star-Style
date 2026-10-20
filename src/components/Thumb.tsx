import { Icon } from "./Icon";

/** Kleines Artikelfoto; ohne Foto ein ruhiger Platzhalter. */
export function Thumb({ id, size = 40, className = "" }: { id?: string | null; size?: number; className?: string }) {
  const style = { width: `${size / 16}rem`, height: `${size / 16}rem` };
  if (!id) return (
    <span style={style} className={`inline-flex shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-300 ring-1 ring-black/5 ${className}`}>
      <Icon name="box" className="h-1/2 w-1/2" />
    </span>
  );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/api/files/${id}`} alt="" loading="lazy" style={style} className={`shrink-0 rounded-lg bg-white object-cover ring-1 ring-black/5 ${className}`} />;
}
