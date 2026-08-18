"use client";

import * as Accordion from "@radix-ui/react-accordion";
import { Plus } from "lucide-react";
import { Section, PAD } from "../primitives/section";
import { SectionTitle } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { faq } from "../content";

/**
 * Two of these answers are deliberately unflattering — search indexing
 * sends unmasked text, and there is no in-product disconnect button. Both
 * are true, both are already public in the architecture doc, and a page
 * that volunteers them is more believable than one that waits to be caught.
 *
 * Radix accordion, already a dependency. First item open so the pattern is
 * legible without a click.
 */
export function Faq() {
  return (
    <Section canvas="white" id={faq.id} className={PAD}>
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.62fr)_minmax(0,1fr)] lg:gap-20">
        <Reveal>
          <SectionTitle className="max-w-[12ch] lg:sticky lg:top-32">{faq.headline}</SectionTitle>
        </Reveal>

        <Reveal delay={0.06}>
          <Accordion.Root
            type="single"
            collapsible
            defaultValue="q0"
            className="border-t border-mr-line"
          >
            {faq.items.map((item, i) => (
              <Accordion.Item
                key={item.q}
                value={`q${i}`}
                className="border-b border-mr-line"
              >
                <Accordion.Header>
                  <Accordion.Trigger
                    className={[
                      "group flex w-full items-start justify-between gap-6 py-5 text-left",
                      "t-lead w540 text-mr-ink transition-colors duration-200",
                      "hover:text-mr-indigo",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mr-indigo",
                    ].join(" ")}
                  >
                    {item.q}
                    <Plus
                      aria-hidden
                      strokeWidth={1.75}
                      className={[
                        "mt-1 size-4 shrink-0 text-mr-faint",
                        "transition-transform duration-300 ease-out",
                        "group-data-[state=open]:rotate-45 group-data-[state=open]:text-mr-indigo",
                        "motion-reduce:transition-none",
                      ].join(" ")}
                    />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content
                  className={[
                    "overflow-hidden",
                    "data-[state=open]:animate-accordion-down",
                    "data-[state=closed]:animate-accordion-up",
                  ].join(" ")}
                >
                  <p className="max-w-[44rem] pb-6 pr-10 t-body w460 text-mr-mute">{item.a}</p>
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        </Reveal>
      </div>
    </Section>
  );
}
