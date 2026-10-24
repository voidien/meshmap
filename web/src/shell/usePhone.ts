import { useEffect, useState } from "react";

const QUERY = "(max-width: 700px)";

/** True on a phone-sized screen (the layout then uses a bottom sheet and a bottom bar). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia !== "undefined" && matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(QUERY);
    const on = () => setPhone(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}
