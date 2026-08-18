import { cn } from "@web/lib/utils";

/**
 * The type scale — the only place size, weight and tracking are set.
 *
 * Sizes and leading live in globals.css under `.mailroid-marketing` (t-*
 * classes) because the 0.96 display leading needs a clamp() that scales
 * continuously; weights are the w460/w540/w600 utilities, which set
 * font-variation-settings rather than font-weight so the variable axis
 * lands on the sub-default values DESIGN.md specifies.
 *
 * If you find yourself writing `text-4xl font-bold` anywhere in
 * components/marketing, use one of these instead.
 */

type As = "h1" | "h2" | "h3" | "p" | "div" | "span";

interface Props extends React.HTMLAttributes<HTMLElement> {
  as?: As;
  className?: string;
  children: React.ReactNode;
}

function make(base: string, defaultAs: As) {
  return function T({ as, className, children, ...rest }: Props) {
    const Tag = (as ?? defaultAs) as As;
    return (
      <Tag className={cn(base, className)} {...rest}>
        {children}
      </Tag>
    );
  };
}

/** 80px. The full-viewport beat, and nothing else on the page. */
export const Beat = make("t-beat w540 text-balance", "h2");
/** 64px. Hero only. */
export const Hero = make("t-hero w540 text-balance", "h1");
/** 48px. Opens a section. */
export const SectionTitle = make("t-section w460 text-balance", "h2");
/** 28px. Sub-section inside a band. */
export const BandTitle = make("t-band w540 text-balance", "h3");
/** 22px. A feature title in a grid. */
export const CardTitle = make("t-card w540 text-balance", "h3");
/** 18px. The marketing lead under a section title. */
export const Lead = make("t-lead w460", "p");
/** 16px. Default running text. */
export const Body = make("t-body w460", "p");
/** 14px. Footnotes, captions. */
export const Caption = make("t-cap w460", "p");
/** 12px uppercase, wide tracking. Eyebrows and column headings. */
export const Micro = make("t-micro w600", "p");
