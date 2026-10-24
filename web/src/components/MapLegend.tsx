import { useState } from "react";
import { LINK_COLORS } from "../map/MapView";

/** The link classes, on the map where the colours are. Collapses to a small button. */
export function MapLegend({ otherName }: { otherName?: string | null }) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem("meshmap.legend");
      // small screens start with the legend folded away
      return saved === null ? !(typeof matchMedia !== "undefined" && matchMedia("(max-width: 700px)").matches) : saved !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem("meshmap.legend", v ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !v;
    });
  };
  if (!open) {
    return (
      <button className="map-legend-btn" onClick={toggle} aria-label="Show the legend">
        Legend
      </button>
    );
  }
  return (
    <section className="map-legend" aria-label="Legend">
      <button className="x" onClick={toggle} aria-label="Hide the legend">
        ×
      </button>
      <span>
        <i style={{ background: LINK_COLORS.clear }} />
        clear
      </span>
      <span>
        <i style={{ background: LINK_COLORS.marginal }} />
        marginal
      </span>
      <span>
        <i style={{ background: LINK_COLORS.obstructed }} />
        obstructed
      </span>
      <span>
        <i className="dashed" />
        not analysed
      </span>
      {otherName ? (
        <span>
          <i className="dashed" />
          dashed colour = “{otherName}”
        </span>
      ) : null}
    </section>
  );
}
