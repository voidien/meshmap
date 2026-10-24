export type NavItem = "map" | "lists" | "add" | "details" | "field";

interface Props {
  active: NavItem;
  onPick: (i: NavItem) => void;
  addDisabled: boolean;
  fieldDisabled: boolean;
}

const ITEMS: { id: NavItem; icon: string; label: string }[] = [
  { id: "map", icon: "🗺", label: "Map" },
  { id: "lists", icon: "☰", label: "Lists" },
  { id: "add", icon: "＋", label: "Add" },
  { id: "details", icon: "◧", label: "Details" },
  { id: "field", icon: "⌖", label: "Field" },
];

/** The phone's bottom bar: five places to go, each a big target. */
export function BottomNav({ active, onPick, addDisabled, fieldDisabled }: Props) {
  return (
    <nav className="bottomnav" aria-label="Main">
      {ITEMS.map((i) => (
        <button key={i.id} id={`nav-${i.id}`} className={active === i.id ? "on" : ""} aria-current={active === i.id ? "page" : undefined} disabled={(i.id === "add" && addDisabled) || (i.id === "field" && fieldDisabled)} onClick={() => onPick(i.id)}>
          <span aria-hidden="true">{i.icon}</span>
          <small>{i.label}</small>
        </button>
      ))}
    </nav>
  );
}
