import { Section, PAD } from "../primitives/section";
import { SectionTitle, Lead, Caption } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { GmailMark, CalendarMark } from "../brand/google-marks";
import { worksWith } from "../content";

/**
 * The objection-killer. A visitor's first thought is "do I have to move my
 * email?" and this band exists to answer it in about four seconds, so it
 * carries no CTA and nothing else competes with the two lines.
 */
export function WorksWith() {
  return (
    <Section canvas="white" className={PAD}>
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-center lg:gap-20">
        <Reveal>
          <SectionTitle>
            {worksWith.headlineA}
            <br />
            <span className="text-mr-mute">{worksWith.headlineB}</span>
          </SectionTitle>
          <Lead className="mt-6 max-w-[34rem] text-mr-mute">{worksWith.body}</Lead>
          <Caption className="mt-4 max-w-[34rem] text-mr-faint">{worksWith.detail}</Caption>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="flex flex-wrap items-center gap-x-12 gap-y-8 lg:justify-end">
            <div className="flex items-center gap-3.5">
              <GmailMark className="h-8 w-auto md:h-9" />
              <span className="t-band w540 text-mr-ink">Gmail</span>
            </div>
            <div className="flex items-center gap-3.5">
              <CalendarMark className="h-9 w-auto md:h-10" />
              <span className="t-band w540 text-mr-ink">Calendar</span>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
