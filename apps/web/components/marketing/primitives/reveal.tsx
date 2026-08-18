"use client";

import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@web/lib/utils";

/**
 * The only scroll-reveal on the page.
 *
 * 16px up, fade in, 420ms, Expo-out. Fires once. Anything that wants to
 * appear on scroll uses this — the restraint is deliberate, and a second
 * reveal style would read as decoration rather than rhythm.
 *
 * Under prefers-reduced-motion the content renders in place with no
 * animation at all, rather than a shortened one.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

export function Reveal({
  delay = 0,
  className,
  as = "div",
  children,
}: {
  delay?: number;
  className?: string;
  as?: "div" | "li" | "section";
  children: React.ReactNode;
}) {
  const still = useReducedMotion();
  const M = motion[as];

  if (still) return <div className={className}>{children}</div>;

  return (
    <M
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-64px" }}
      transition={{ duration: 0.42, ease: EASE, delay }}
    >
      {children}
    </M>
  );
}

/**
 * Reveals children in sequence, 60ms apart. Use for a group of siblings
 * (feature blocks, trust rows) so they arrive as a wave rather than
 * simultaneously — the one place stagger earns its keep.
 */
export function RevealGroup({
  className,
  step = 0.06,
  start = 0,
  children,
}: {
  className?: string;
  step?: number;
  start?: number;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div className={cn(className)}>
      {items.map((child, i) => (
        <Reveal key={i} delay={start + i * step}>
          {child}
        </Reveal>
      ))}
    </div>
  );
}
