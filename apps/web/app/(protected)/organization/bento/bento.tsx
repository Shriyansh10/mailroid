"use client";

import type { LucideIcon } from "lucide-react";

import { cn } from "@web/lib/utils";

import { STATUS_LABEL, STATUS_TAG, avatarColor, initials, type Status } from "./lib";

/**
 * The 12-column grid. Spans collapse at md (6 of 12 for the small tiles, full
 * width for the rest) and to one column on a phone, so nothing ever needs a
 * horizontal scroll except the people table, which scrolls inside its card.
 */
export function Bento({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-12 gap-4">{children}</div>;
}

const SPAN = {
  3: "col-span-12 md:col-span-6 xl:col-span-3",
  4: "col-span-12 md:col-span-6 xl:col-span-4",
  5: "col-span-12 xl:col-span-5",
  7: "col-span-12 xl:col-span-7",
  8: "col-span-12 xl:col-span-8",
  12: "col-span-12",
} as const;

export function BentoCard({
  span,
  tall,
  className,
  style,
  children,
}: {
  span: keyof typeof SPAN;
  /** Occupies two rows beside the KPI tiles (the hero). */
  tall?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative min-w-0 rounded-[22px] bg-(--ob-surface) px-5 py-5 text-(--ob-ink) shadow-(--ob-shadow)",
        SPAN[span],
        tall && "xl:row-span-2",
        className,
      )}
      style={style}
    >
      {children}
    </section>
  );
}

export function CardHead({
  icon: Icon,
  title,
  sub,
  right,
  tone = "default",
}: {
  icon: LucideIcon;
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  /** "inverse" on the dark hero gradient. */
  tone?: "default" | "inverse";
}) {
  const inverse = tone === "inverse";
  return (
    <div className="mb-3.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          <Icon className={cn("size-4 shrink-0", inverse ? "text-[#c9bdff]" : "text-(--ob-accent)")} />
          {title}
        </h2>
        {sub ? (
          <p className={cn("mt-0.5 text-[12.5px] font-medium", inverse ? "text-[#b9b0e6]" : "text-(--ob-muted)")}>
            {sub}
          </p>
        ) : null}
      </div>
      {right}
    </div>
  );
}

export function StatusTag({ status, title }: { status: Status; title?: string }) {
  const tone = STATUS_TAG[status];
  return (
    <span
      className="inline-flex w-max items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold"
      style={{ background: tone.bg, color: tone.ink }}
      title={title}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Avatar({ email, label, size = 36 }: { email: string; label: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-xl font-extrabold text-white"
      style={{ width: size, height: size, background: avatarColor(email), fontSize: size * 0.33 }}
    >
      {initials(label)}
    </span>
  );
}

/** A labelled horizontal bar. `value` is a share of `max`; a non-zero value never renders invisible. */
export function Track({
  value,
  max,
  color,
  height = 8,
}: {
  value: number;
  max: number;
  color: string;
  height?: number;
}) {
  const pct = max > 0 ? (100 * value) / max : 0;
  return (
    <span
      className="relative block overflow-hidden rounded-full bg-(--ob-track)"
      style={{ height }}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${value > 0 ? Math.max(3, pct) : 0}%`, background: color }}
      />
    </span>
  );
}
