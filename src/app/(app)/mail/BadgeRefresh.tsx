"use client";
import { useEffect } from "react";

/** Nach dem Öffnen einer E-Mail: Zahl der Ungelesenen im Menü gleich neu laden */
export function BadgeRefresh({ k }: { k: string }) {
  useEffect(() => { window.dispatchEvent(new Event("ss:badges")); }, [k]);
  return null;
}
