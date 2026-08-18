import { Fragment } from "react";
import { cn } from "@web/lib/utils";

/** A keyboard key, sized to sit inside running prose without breaking the line. */
export function Key({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "mx-0.5 inline-flex min-w-[1.55em] items-center justify-center rounded",
        "border border-mr-line bg-mr-canvas px-1.5 py-0.5",
        "font-mono text-[0.8em] leading-none text-mr-ink",
        "shadow-[0_1px_0_rgba(41,40,39,0.06)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * Renders a sentence with {x} placeholders turned into <Key> chips, so the
 * shortcut copy stays one readable string in content.ts instead of being
 * assembled out of fragments in JSX.
 *
 *   "{j} {k} to move, {o} to open" → [j] [k] to move, [o] to open
 */
export function WithKeys({ text }: { text: string }) {
  const parts = text.split(/(\{[^}]+\})/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("{") && part.endsWith("}") ? (
          <Key key={i}>{part.slice(1, -1)}</Key>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
