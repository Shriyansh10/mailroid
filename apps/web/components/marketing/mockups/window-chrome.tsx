import { cn } from "@web/lib/utils";

/**
 * The shared frame every product mockup sits in.
 *
 * All mockups are built in DOM from the real tokens rather than
 * screenshotted: they stay sharp at any DPI, weigh nothing, animate by
 * prop, reflow on mobile — and no screenshot of a real mailbox can leak
 * anyone's mail into a marketing page.
 *
 * Decorative by definition. Every caller marks the frame aria-hidden and
 * puts a real text equivalent beside it.
 */
export function Window({
  className,
  bodyClassName,
  children,
}: {
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "overflow-hidden rounded-xl border border-mr-line bg-mr-canvas",
        "shadow-[0_8px_24px_rgba(27,25,56,0.12)]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-mr-line/70 bg-mr-soft px-4 py-3">
        <span className="size-2.5 rounded-full bg-mr-line" />
        <span className="size-2.5 rounded-full bg-mr-line" />
        <span className="size-2.5 rounded-full bg-mr-line" />
      </div>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </div>
  );
}
