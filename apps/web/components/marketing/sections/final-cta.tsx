import { Section } from "../primitives/section";
import { Caption } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { Button } from "../primitives/button";
import { finalCta } from "../content";

/**
 * The closing teal band. DESIGN.md: every marketing page resolves here, and
 * the teal is a single chromatic interlude — it appears exactly once on the
 * page, and nowhere above this point.
 *
 * One button. No secondary action, no links, no icons.
 */
export function FinalCta() {
  return (
    <Section canvas="teal" bleed className="py-24 md:py-32 lg:py-40">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-mr-teal-mid opacity-40 blur-[140px]" />
      </div>

      <div className="relative mx-auto w-full max-w-[1100px] px-6 text-center md:px-10">
        <Reveal>
          <h2 className="t-section w540 text-white">
            {finalCta.l1}
            <br />
            {finalCta.l2}
          </h2>

          <div className="mt-10 flex justify-center">
            <Button href={finalCta.ctaHref} variant="onTeal">
              {finalCta.cta}
            </Button>
          </div>

          <Caption className="mt-5 text-white/50">{finalCta.note}</Caption>
        </Reveal>
      </div>
    </Section>
  );
}
