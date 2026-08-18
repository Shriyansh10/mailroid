import { Section } from "../primitives/section";
import { Micro, Caption } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { GmailMark, CalendarMark } from "../brand/google-marks";
import { poweredBy } from "../content";

/**
 * Replaces testimonials. Mailroid has no users to quote, and inventing
 * named people at named companies would be a fabricated endorsement — for a
 * pre-launch product a visible stack is the more credible thing anyway.
 *
 * The Google marks appear here as well as in "Works with", doing a
 * different job: that section answers "do I have to migrate?", this one
 * answers "who is behind this?". Same logos, most of a page apart.
 */
export function PoweredBy() {
  return (
    <Section canvas="soft" className="py-20 md:py-24">
      <Reveal>
        <div className="flex flex-col items-center text-center">
          <Micro className="text-mr-faint">{poweredBy.label}</Micro>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-14 gap-y-7">
            <div className="flex items-center gap-3.5">
              <GmailMark className="h-9 w-auto" />
              <span className="t-band w540 text-mr-ink">Gmail</span>
            </div>
            <div className="flex items-center gap-3.5">
              <CalendarMark className="h-10 w-auto" />
              <span className="t-band w540 text-mr-ink">Google Calendar</span>
            </div>
          </div>

          <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
            {poweredBy.stack.map((item, i) => (
              <li key={item} className="flex items-center gap-3">
                <span className="t-cap w460 text-mr-mute">{item}</span>
                {i < poweredBy.stack.length - 1 && (
                  <span aria-hidden className="text-mr-line">
                    ·
                  </span>
                )}
              </li>
            ))}
          </ul>

          <Caption className="mt-8 max-w-[44rem] text-mr-faint">{poweredBy.note}</Caption>
        </div>
      </Reveal>
    </Section>
  );
}
