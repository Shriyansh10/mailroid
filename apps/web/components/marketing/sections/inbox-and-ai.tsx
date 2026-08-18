import { Section, PAD } from "../primitives/section";
import { SectionTitle, Lead, CardTitle, Body } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { WithKeys } from "../primitives/kbd";
import { inbox } from "../content";

/**
 * Inbox and assistant, merged and interleaved.
 *
 * The order alternates mailbox → assistant → mailbox → assistant on
 * purpose. Split into an "inbox" list and an "AI" list, the assistant reads
 * as something bolted on beside the mail; interleaved, it reads as part of
 * how the mail works. Do not regroup these.
 */
export function InboxAndAi() {
  return (
    <Section canvas="soft" id={inbox.id} className={PAD}>
      <Reveal>
        <SectionTitle className="max-w-[16ch]">{inbox.headline}</SectionTitle>
        <Lead className="mt-6 max-w-[40rem] text-mr-mute">{inbox.body}</Lead>
      </Reveal>

      <div className="mt-16 grid gap-x-16 gap-y-12 md:grid-cols-2 lg:mt-20 lg:gap-y-14">
        {inbox.points.map((p, i) => (
          <Reveal key={p.title} delay={(i % 2) * 0.06}>
            <CardTitle>{p.title}</CardTitle>
            <Body className="mt-3 text-mr-mute">
              <WithKeys text={p.body} />
            </Body>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
