import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@web/lib/utils";

/**
 * DESIGN.md's shape rule, made hard to break:
 *
 *   8px rounded rectangle everywhere. The pill appears exactly once, in the
 *   hero, and nowhere else.
 *
 * That is why `pill` is a named variant rather than a radius prop — a
 * second pill on the page requires deliberately typing the word twice.
 */
const button = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "px-5 py-3 t-body w600",
    // 150–300ms, transform + colour only.
    "transition-[transform,background-color,box-shadow,border-color] duration-200 ease-out",
    "active:scale-[0.98] motion-reduce:active:scale-100",
    "focus-visible:outline-2 focus-visible:outline-offset-4",
  ].join(" "),
  {
    variants: {
      variant: {
        /** Hero only. The single pill on the page. */
        pill: [
          "rounded-full bg-mr-violet text-mr-indigo",
          "shadow-[0_1px_3px_rgba(14,12,31,0.28)]",
          "hover:brightness-[1.06] hover:shadow-[0_8px_24px_rgba(201,180,250,0.34)]",
          "focus-visible:outline-mr-violet",
        ].join(" "),
        /** The dominant CTA on white surfaces. */
        solid: [
          "rounded-lg bg-mr-indigo text-white",
          "hover:bg-mr-indigo-deep hover:shadow-[0_8px_24px_rgba(27,25,56,0.18)]",
          "focus-visible:outline-mr-indigo",
        ].join(" "),
        /** Outline alternative on white. */
        outline: [
          "rounded-lg bg-mr-canvas text-mr-ink border border-mr-line-dark/30",
          "hover:border-mr-line-dark/60 hover:shadow-[0_1px_3px_rgba(41,40,39,0.08)]",
          "focus-visible:outline-mr-indigo",
        ].join(" "),
        /** Inside the closing teal band. */
        onTeal: [
          "rounded-lg bg-white text-mr-teal",
          "hover:shadow-[0_8px_28px_rgba(0,0,0,0.28)]",
          "focus-visible:outline-white",
        ].join(" "),
        /** Small, on the indigo nav. */
        navSolid: [
          "rounded-lg bg-white text-mr-indigo px-4 py-2 t-cap",
          "hover:bg-mr-violet focus-visible:outline-white",
        ].join(" "),
      },
      full: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "solid", full: false },
  },
);

type Props = VariantProps<typeof button> & {
  href: string;
  className?: string;
  children: React.ReactNode;
};

export function Button({ href, variant, full, className, children }: Props) {
  return (
    <Link href={href} className={cn(button({ variant, full }), className)}>
      {children}
    </Link>
  );
}

/**
 * A text link, not a button. The hero's second action is one of these — the
 * brief asked for two hero CTAs and DESIGN.md allows one button per band,
 * so the second is a link and the rule survives.
 */
export function TextLink({
  href,
  onDark = false,
  className,
  children,
}: {
  href: string;
  onDark?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-1.5 t-body w540",
        "transition-colors duration-200",
        "focus-visible:outline-2 focus-visible:outline-offset-4 rounded-sm",
        onDark
          ? "text-white/80 hover:text-white focus-visible:outline-mr-violet"
          : "text-mr-indigo hover:text-mr-indigo-deep focus-visible:outline-mr-indigo",
        className,
      )}
    >
      <span className="underline decoration-current/25 underline-offset-4 transition-[text-decoration-color] duration-200 group-hover:decoration-current/70">
        {children}
      </span>
      <span
        aria-hidden
        className="translate-y-0 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
      >
        →
      </span>
    </Link>
  );
}
