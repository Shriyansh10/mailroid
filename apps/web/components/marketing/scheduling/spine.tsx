"use client";

import { motion, useReducedMotion } from "framer-motion";
import { scheduling } from "../content";

/**
 * The unbroken line.
 *
 * Everywhere else, a thread and a meeting are two unrelated objects in two
 * unrelated applications. Here they are five points on one line that never
 * breaks — and the line drawing itself in a single continuous stroke is the
 * argument, so it is one element scaling from the top, never five segments
 * animating in turn.
 */
export function Spine() {
  const still = useReducedMotion();

  return (
    <ol className="relative flex flex-col gap-9 py-1 pl-7">
      {/* The line. One element, one stroke, top to bottom. */}
      <motion.span
        aria-hidden
        className="absolute bottom-2 left-[3px] top-2 w-px origin-top bg-mr-indigo/35"
        initial={still ? undefined : { scaleY: 0 }}
        whileInView={still ? undefined : { scaleY: 1 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
      />

      {scheduling.spine.map((label, i) => (
        <motion.li
          key={label}
          className="relative t-body w460 text-mr-ink"
          initial={still ? undefined : { opacity: 0, x: -6 }}
          whileInView={still ? undefined : { opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{
            duration: 0.4,
            ease: [0.16, 1, 0.3, 1],
            delay: still ? 0 : 0.22 + i * 0.14,
          }}
        >
          <span
            aria-hidden
            className="absolute -left-7 top-[0.45rem] size-[7px] rounded-full bg-mr-indigo ring-4 ring-mr-canvas"
          />
          {label}
        </motion.li>
      ))}
    </ol>
  );
}
