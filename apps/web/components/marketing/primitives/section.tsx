import { cn } from "@web/lib/utils";

/**
 * The three-canvas rhythm from DESIGN.md, enforced in one place.
 *
 * indigo → white/soft alternating → teal close. There is no fourth canvas
 * colour and adding one breaks the system, so `canvas` is a closed union
 * rather than a className passthrough.
 */
type Canvas = "indigo" | "white" | "soft" | "teal";

const CANVAS: Record<Canvas, string> = {
  indigo: "bg-mr-indigo text-white",
  white: "bg-mr-canvas text-mr-ink",
  soft: "bg-mr-soft text-mr-ink",
  teal: "bg-mr-teal text-white",
};

export function Section({
  canvas,
  id,
  className,
  containerClassName,
  bleed = false,
  children,
}: {
  canvas: Canvas;
  id?: string;
  className?: string;
  containerClassName?: string;
  /** Skip the centred container — for full-bleed sections that lay out their own. */
  bleed?: boolean;
  children: React.ReactNode;
}) {
  return (
    // `overflow-x-clip`, not `overflow-hidden`. Both stop the hero's
    // half-bleed window from producing a horizontal scrollbar, but `hidden`
    // makes this element a scrollport and silently kills every `position:
    // sticky` inside it — which would break the spine and the demo stage in
    // the scheduling section. `clip` leaves the y-axis visible and sticky
    // working.
    <section
      id={id}
      className={cn("relative w-full overflow-x-clip", CANVAS[canvas], className)}
    >
      {bleed ? (
        children
      ) : (
        <div className={cn("mx-auto w-full max-w-[1100px] px-6 md:px-10", containerClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Standard section padding. The teal close overrides this with more air. */
export const PAD = "py-20 md:py-28 lg:py-32";
