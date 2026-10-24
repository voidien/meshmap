import { useEffect, useId, useState } from "react";

interface Props {
  value: number;
  /** called with a valid number, when the person finishes typing (blur / Enter) or steps with the arrow keys */
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  "aria-label"?: string;
}

/** Strip trailing zeros of a number shown in a field. */
const show = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(6))) : "");

/** A number input that keeps what is being typed until it is finished, so clearing and retyping a value works and nothing is saved halfway. */
export function NumberField({ value, onCommit, min, max, step = 1, id, ...rest }: Props) {
  const [text, setText] = useState(show(value));
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const errId = useId();
  useEffect(() => {
    if (!editing) setText(show(value));
  }, [value, editing]);

  const check = (v: number): string | null => {
    if (!Number.isFinite(v)) return "Enter a number.";
    if (min !== undefined && v < min) return `At least ${min}.`;
    if (max !== undefined && v > max) return `At most ${max}.`;
    return null;
  };
  const commit = () => {
    setEditing(false);
    const v = Number(text.trim().replace(",", "."));
    const err = text.trim() === "" ? "Enter a number." : check(v);
    if (err) {
      setBad(err);
      setText(show(value)); // put the old value back; the message explains
      return;
    }
    setBad(null);
    if (v !== value) onCommit(v);
    setText(show(v));
  };

  return (
    <>
      <input
        id={id}
        type="text"
        inputMode={min !== undefined && min >= 0 ? "decimal" : "text"}
        value={text}
        aria-invalid={bad ? true : undefined}
        aria-describedby={bad ? errId : undefined}
        aria-label={rest["aria-label"]}
        onFocus={(e) => (setEditing(true), e.target.select())}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
          setBad(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setText(show(value));
            setEditing(false);
            setBad(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const cur = Number(text.trim().replace(",", "."));
            const base = Number.isFinite(cur) ? cur : value;
            const next = Number((base + (e.key === "ArrowUp" ? step : -step)).toFixed(6));
            if (!check(next)) {
              setText(show(next));
              onCommit(next);
            }
          }
        }}
      />
      {bad ? (
        <small id={errId} className="field-error" role="alert">
          {bad}
        </small>
      ) : null}
    </>
  );
}
