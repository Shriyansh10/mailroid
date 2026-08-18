import { Section, PAD } from "../primitives/section";
import { SectionTitle, Lead, CardTitle, Body } from "../primitives/type";
import { Reveal } from "../primitives/reveal";
import { Spine } from "../scheduling/spine";
import { SchedulingStage } from "../scheduling/stage";
import { scheduling } from "../content";

/**
 * The differentiator, and the reason this section sits ahead of the inbox
 * one: a priority inbox is table stakes, a meeting that stays bound to its
 * thread is not.
 */
export function Scheduling() {
  return (
    <Section canvas="white" id={scheduling.id} className={PAD}>
      <Reveal>
        <SectionTitle className="max-w-[18ch]">{scheduling.headline}</SectionTitle>
        <Lead className="mt-6 max-w-[40rem] text-mr-mute">{scheduling.body}</Lead>
      </Reveal>

      {/* The spine is handed to the stage rather than placed beside it: both
          have to pin to the same sticky container or they drift apart as you
          scroll. See the layout note in stage.tsx. */}
      <div className="mt-16 lg:mt-20">
        <SchedulingStage aside={<Spine />} />
      </div>

      <div className="mt-16 grid gap-10 border-t border-mr-line pt-12 md:grid-cols-3 md:gap-12 lg:mt-20">
        {scheduling.points.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.06}>
            <CardTitle>{p.title}</CardTitle>
            <Body className="mt-3 text-mr-mute">{p.body}</Body>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
