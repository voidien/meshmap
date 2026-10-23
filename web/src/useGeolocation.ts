import { useEffect, useState } from "react";

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
  /** Direction of travel in degrees, when moving */
  heading: number | null;
  at: number;
}

/** The phone's GPS position while `active`. */
export function useGeolocation(active: boolean) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    if (!("geolocation" in navigator)) {
      setError("This device or browser has no location support.");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null);
        setFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: p.coords.accuracy, heading: p.coords.heading !== null && Number.isFinite(p.coords.heading) ? p.coords.heading : null, at: p.timestamp });
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? "Location is blocked. Allow it for this site in the browser settings." : e.code === e.POSITION_UNAVAILABLE ? "No GPS position yet. Go outside, or check location services are on." : "Waiting for GPS…"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
  return { fix, error };
}
