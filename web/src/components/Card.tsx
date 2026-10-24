import type { ReactNode } from "react";

interface Props {
  /** kept for the places that name their panel (the element id of the section is `domId`) */
  id: string;
  title: ReactNode;
  children: ReactNode;
  /** The element id of the section itself. */
  domId?: string;
  className?: string;
}

/** A panel in the lists or details column: a heading and its content. */
export function Card({ title, children, domId, className = "" }: Props) {
  return (
    <section className={`card flat ${className}`} id={domId}>
      <h3 className="flat-title">{title}</h3>
      <div className="cardbody">{children}</div>
    </section>
  );
}
