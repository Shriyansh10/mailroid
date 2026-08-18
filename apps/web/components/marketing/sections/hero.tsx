import { Section } from "../primitives/section";
import { Hero as HeroType, Lead, Caption, Micro } from "../primitives/type";
import { Button, TextLink } from "../primitives/button";
import { InboxList, InboxRail } from "../mockups/inbox";
import { hero, BADGE } from "../content";

/**
 * The fold. Indigo canvas, violet-sky wash, type on the left, product
 * half-bleeding off the right edge.
 *
 * DESIGN.md puts a half-bleed portrait photograph in this slot; the brief
 * rules out photography, so the product window takes the same composition —
 * edge-to-edge vertically, stopping mid-canvas, type anchored left. It is
 * one window, not a layered composite: the scheduling section does the
 * demonstrating, and two busy things above the fold cancel each other out.
 */
export function HeroSection() {
  return (
    <Section canvas="indigo" bleed className="pt-28 md:pt-32 lg:pt-36">
      {/* The violet-sky atmospheric backdrop — the hero's only depth medium. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-56 size-[42rem] rounded-full bg-[#4b3f8f] opacity-[0.30] blur-[120px]" />
        <div className="absolute right-[-12rem] top-[-8rem] size-[36rem] rounded-full bg-mr-violet opacity-[0.16] blur-[130px]" />
        <div className="absolute bottom-[-18rem] left-1/3 size-[34rem] rounded-full bg-[#2b6fa8] opacity-[0.16] blur-[140px]" />
      </div>

      <div className="relative mx-auto grid w-full max-w-[1240px] items-center gap-14 px-6 pb-20 md:px-10 md:pb-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.78fr)] lg:gap-12 lg:pb-32">
        <div className="max-w-[36rem]">
          <Micro className="text-mr-violet">{BADGE}</Micro>

          <HeroType className="mt-6 text-white">{hero.headline}</HeroType>

          <Lead className="mt-6 max-w-[34rem] text-white/70">
            {/* The canonical sentence leads, brighter than what follows it. */}
            <span className="w540 text-white">{hero.taglineLead}</span> {hero.taglineRest}
          </Lead>

          <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
            {/* The only pill on the page. */}
            <Button href={hero.ctaHref} variant="pill">
              {hero.cta}
            </Button>
            {/* Second action is a link, not a button — one button per band. */}
            <TextLink href="#scheduling" onDark>
              {hero.scrollLink}
            </TextLink>
          </div>

          <Caption className="mt-6 text-white/40">{hero.footnote}</Caption>
        </div>

        {/* Half-bleed: runs past the right edge so it reads as a window onto
            something larger — but only just. The card is capped at 560px
            because a wider one stretches every row and leaves a gulf between
            the subject and its timestamp, which reads as an empty table
            rather than a busy mailbox. `ml-auto` keeps it pinned right as
            the column grows. */}
        <div className="relative lg:-mr-14 xl:-mr-20">
          <div
            aria-hidden
            className="mr-float w-full max-w-[560px] overflow-hidden rounded-xl border border-white/10 bg-mr-canvas shadow-[0_24px_70px_rgba(6,4,20,0.55)] lg:ml-auto"
          >
            <div className="flex items-center gap-2 border-b border-mr-line bg-mr-soft px-4 py-3">
              <span className="size-2.5 rounded-full bg-mr-line" />
              <span className="size-2.5 rounded-full bg-mr-line" />
              <span className="size-2.5 rounded-full bg-mr-line" />
              <div className="ml-3 flex h-6 flex-1 items-center rounded-md border border-mr-line bg-mr-canvas px-2.5">
                <span className="text-[0.6875rem] w460 text-mr-faint">Search your mail</span>
                <span className="mr-caret ml-0.5 inline-block h-3 w-px bg-mr-indigo/70" />
              </div>
            </div>
            <div className="flex gap-2 p-3">
              <InboxRail />
              <InboxList className="min-w-0 flex-1" selected={0} />
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
