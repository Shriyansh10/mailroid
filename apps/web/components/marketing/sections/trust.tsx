"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { Section, PAD } from "../primitives/section";
import { SectionTitle, Lead, Caption } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { TextLink } from "../primitives/button";
import { ApprovalCard } from "../mockups/thread-parts";
import { trust } from "../content";

/**
 * The trust section. Deliberately the only place on the page that talks
 * about security, and deliberately in outcomes rather than architecture —
 * no Zod, no XML tool framing, no single-flight. Those live in the
 * architecture doc, which the closing link points at.
 *
 * The four rows are worded as things that are true for the reader. Row 1 in
 * particular says "Gmail stays the source of truth" and not "your mail
 * never leaves Google": Mailroid does keep a synced copy of message bodies,
 * that is what makes local search work, and the FAQ says so. A reassurance
 * the security doc contradicts is worse than no reassurance.
 */
export function Trust() {
  return (
    <Section canvas="white" id={trust.id} className={PAD}>
      <Reveal>
        <SectionTitle className="max-w-[16ch]">
          {trust.headlineA}
          <br />
          <span className="text-mr-mute">{trust.headlineB}</span>
        </SectionTitle>
        <Lead className="mt-7 max-w-[42rem] text-mr-mute">{trust.body}</Lead>
      </Reveal>

      <div className="mt-16 flex flex-col items-center lg:mt-20">
        <ApprovalCardWithPress />
        <Caption className="mt-7 max-w-[38rem] text-center text-mr-mute">
          {trust.cardCaption}
        </Caption>
      </div>

      <dl className="mt-16 grid gap-8 border-t border-mr-line pt-12 sm:grid-cols-2 lg:mt-20 lg:grid-cols-4 lg:gap-6">
        {trust.rows.map((r, i) => (
          <Reveal key={r.title} delay={i * 0.05}>
            <div className="lg:border-l lg:border-mr-line lg:pl-5">
              <dt className="t-body w540 text-mr-ink">{r.title}</dt>
              <dd className="mt-2 t-cap w460 text-mr-mute">{r.body}</dd>
            </div>
          </Reveal>
        ))}
      </dl>

      {trust.linkHref && (
        <Reveal delay={0.1}>
          <div className="mt-12">
            <TextLink href={trust.linkHref}>{trust.link}</TextLink>
          </div>
        </Reveal>
      )}
    </Section>
  );
}

/**
 * The card, with a cursor that arrives once and presses Approve.
 *
 * The single most persuasive object on the page is a human clicking one
 * button, so it is worth showing rather than describing. It plays once, on
 * entry, and never loops — a looping cursor turns proof into a screensaver.
 */
function ApprovalCardWithPress() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-120px" });
  const still = useReducedMotion();
  const play = inView && !still;

  return (
    <div ref={ref} className="relative w-full max-w-[560px]">
      <motion.div
        initial={still ? undefined : { opacity: 0, y: 18 }}
        animate={still ? undefined : inView ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <ApprovalCard />
      </motion.div>

      {play && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute z-10 size-4 rounded-full border-2 border-mr-indigo bg-mr-canvas/70"
          initial={{ opacity: 0, left: "42%", top: "62%" }}
          animate={{
            opacity: [0, 1, 1, 1, 0],
            left: ["42%", "78%", "82%", "82%", "82%"],
            top: ["62%", "88%", "92%", "92%", "92%"],
            scale: [1, 1, 0.82, 1, 1],
          }}
          transition={{
            duration: 1.9,
            times: [0, 0.35, 0.62, 0.74, 1],
            ease: [0.16, 1, 0.3, 1],
            delay: 0.7,
          }}
        />
      )}
    </div>
  );
}
