"use client";

import { useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "framer-motion";
import { useIsMobile } from "@web/hooks/use-mobile";
import { cn } from "@web/lib/utils";
import { Window } from "../mockups/window-chrome";
import { InboxList } from "../mockups/inbox";
import {
  CalendarGrid,
  MeetingCard,
  SlotPicker,
  ThreadHead,
} from "../mockups/thread-parts";

/**
 * The scroll-driven demo.
 *
 * A morph, not a slideshow — and that distinction is the section's whole
 * argument. One window persists across every state; only what is inside it
 * changes, and it changes by cross-fade with the frame held constant. Three
 * separate things fading in would say "three features". One object that
 * keeps changing says "one workflow", without spending a word of copy on it.
 *
 * Scroll-*linked*, not scroll-*jacking*: the page never captures or
 * redirects the scroll. A flick still moves the page, the scrollbar still
 * means what it says, the back button still works.
 *
 * LAYOUT NOTE — the spine comes in as `aside` and is rendered *inside* the
 * sticky block rather than beside it. An earlier version stuck the two
 * separately (spine at top-32, stage at top-0) inside one very tall grid
 * row; they pinned at different offsets, drifted apart as you scrolled, and
 * the short spine column left a dead gap once it released. Anything that
 * has to stay aligned with the card has to share its sticky container.
 *
 * Two escape hatches, both deliberate:
 *   • prefers-reduced-motion → every state at once, stacked and still.
 *   • below the mobile breakpoint → the same stack. Scroll-linked animation
 *     on touch is this page's only real jank risk, and a stuttering demo
 *     argues against the product better than no demo at all.
 */

const STATES = [
  { key: "inbox", label: "An email arrives and is sorted by what it needs." },
  { key: "thread", label: "You open the thread." },
  { key: "meeting", label: "The meeting is created against that thread, and stays attached to it." },
  { key: "slots", label: "Times are ranked against your real calendar, with the reason for each." },
  { key: "booked", label: "One click books it. The invite is a real Google Calendar event." },
] as const;

const EASE = [0.16, 1, 0.3, 1] as const;

/** Shared by both layouts so the columns line up whichever one renders. */
const GRID = "grid gap-12 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-16";

export function SchedulingStage({ aside }: { aside: React.ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(0);
  const still = useReducedMotion();
  const isMobile = useIsMobile();

  const { scrollYProgress } = useScroll({
    target: track,
    offset: ["start start", "end end"],
  });

  useMotionValueEvent(scrollYProgress, "change", (p) => {
    const i = Math.min(STATES.length - 1, Math.max(0, Math.floor(p * STATES.length * 0.98)));
    setState(i);
  });

  if (still || isMobile) {
    return (
      <div className={GRID}>
        <div>{aside}</div>
        <StaticStack />
      </div>
    );
  }

  return (
    <div ref={track} className="relative h-[300vh]">
      {/* One sticky block holds both columns, so the spine and the card are
          pinned by the same rule and stay level with each other. */}
      <div className="sticky top-20 flex h-[calc(100svh-5rem)] items-center">
        <div className={cn(GRID, "w-full items-center")}>
          <div>{aside}</div>

          <div>
            <Window className="w-full max-w-[520px]" bodyClassName="p-0">
              {/* Fixed height, so the frame itself never resizes between
                  states — the object stays put and only its contents change. */}
              <div className="relative h-[336px]">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={STATES[state]!.key}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.3, ease: EASE }}
                    className="absolute inset-0 overflow-hidden p-4"
                  >
                    <StateView index={state} />
                  </motion.div>
                </AnimatePresence>
              </div>
            </Window>

            {/* Progress as five hairlines. No numbers, no captions — the
                moment it narrates itself it stops feeling effortless. */}
            <div className="mt-6 flex w-full max-w-[520px] gap-1.5" aria-hidden>
              {STATES.map((s, i) => (
                <span
                  key={s.key}
                  className={cn(
                    "h-px flex-1 rounded-full transition-colors duration-500",
                    i <= state ? "bg-mr-indigo/45" : "bg-mr-line",
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* The animation is decorative; this is the real content for anyone
          not watching it. */}
      <ol className="sr-only">
        {STATES.map((s) => (
          <li key={s.key}>{s.label}</li>
        ))}
      </ol>
    </div>
  );
}

function StateView({ index }: { index: number }) {
  switch (index) {
    case 0:
      return <InboxList selected={0} compact />;
    case 1:
      return <ThreadHead />;
    case 2:
      return (
        <div className="space-y-6">
          <ThreadHead />
          <MeetingCard />
        </div>
      );
    case 3:
      return (
        <div className="space-y-5">
          <MeetingCard tethered={false} />
          <SlotPicker chosen={0} />
        </div>
      );
    default:
      return (
        <div className="space-y-5">
          <MeetingCard tethered={false} />
          <CalendarGrid />
        </div>
      );
  }
}

/** Reduced motion and small screens: the same five states, stacked and still. */
function StaticStack() {
  return (
    <ol className="flex flex-col gap-5">
      {STATES.map((s, i) => (
        <li key={s.key}>
          <Window bodyClassName="p-4">
            <StateView index={i} />
          </Window>
          <p className="mt-2.5 px-1 t-cap w460 text-mr-mute">{s.label}</p>
        </li>
      ))}
    </ol>
  );
}
