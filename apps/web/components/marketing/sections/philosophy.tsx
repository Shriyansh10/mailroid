import { Section } from "../primitives/section";
import { SectionTitle, BandTitle } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { philosophy, beat } from "../content";

/**
 * Two stanzas and a lot of air. No paragraph, no illustration, no button.
 *
 * The Stitch preview came back with this section's type undersized, which
 * left it whispering into the beat below instead of building toward it — so
 * the scale here is held deliberately large and the measure deliberately
 * narrow.
 */
export function Philosophy() {
  return (
    <Section canvas="soft" className="py-28 md:py-40 lg:py-48">
      <div className="max-w-[42rem]">
        <Reveal>
          <SectionTitle>
            {philosophy.a1}
            <br />
            <span className="text-mr-mute">{philosophy.a2}</span>
          </SectionTitle>
        </Reveal>

        {/* The gap is the point. Do not put anything in it. */}
        <div className="h-24 md:h-32" />

        <Reveal delay={0.1}>
          <BandTitle as="p" className="text-mr-ink">
            {philosophy.b1}
            <br />
            {philosophy.b2}
          </BandTitle>
        </Reveal>
      </div>
    </Section>
  );
}

/**
 * The beat. Full viewport, indigo, two lines, nothing else — no nav
 * visible, no scroll cue, no illustration.
 *
 * The page argues rationally up to this point; this is the one place it
 * stops arguing. Returning to indigo after two light sections is what gives
 * it force: the reader has settled into a rhythm and the floor drops out
 * for one screen.
 */
export function Beat() {
  return (
    <Section canvas="indigo" bleed className="flex min-h-[86svh] items-center">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -bottom-40 -right-32 size-[38rem] rounded-full bg-mr-violet opacity-[0.12] blur-[150px]" />
      </div>
      <div className="relative mx-auto w-full max-w-[1100px] px-6 py-28 md:px-10">
        <Reveal>
          {/* A real heading, not decorative type — it belongs in the outline. */}
          <h2 className="t-beat w540 max-w-[20ch] text-white">
            {beat.l1}
            <br />
            {beat.l2}
          </h2>
        </Reveal>
      </div>
    </Section>
  );
}
