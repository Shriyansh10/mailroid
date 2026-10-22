import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError, maskMailboxTextForModel } from "@repo/ai";
import { getOrGenerateBrief } from "@repo/services/gmail/index";

export interface GenerateExecutiveBriefInput {}
export interface GenerateExecutiveBriefOutput {
  briefing: string;
}

export class CorsairGenerateBriefExecutor
  implements ToolExecutor<GenerateExecutiveBriefInput, GenerateExecutiveBriefOutput>
{
  async execute(
    _args: GenerateExecutiveBriefInput,
    ctx: { userId: string; requestId: string },
  ): Promise<GenerateExecutiveBriefOutput> {
    console.log("[executor:generateExecutiveBrief] START", { userId: ctx.userId });
    try {
      // Format current date in local YYYY-MM-DD
      const now = new Date();
      const offset = now.getTimezoneOffset();
      const localDate = (new Date(now.getTime() - offset * 60 * 1000)
        .toISOString()
        .split("T")[0]) || "";

      const briefing = await getOrGenerateBrief(ctx.userId, localDate);

      // The stored brief embeds raw From headers, the organizer's address and
      // invite descriptions. It is prose, so the whole text is masked for the
      // model; the brief shown in the inbox is unchanged.
      return { briefing: maskMailboxTextForModel(briefing) };
    } catch (error) {
      console.error("[executor:generateExecutiveBrief] FAILED", { userId: ctx.userId, error: String(error) });
      throw new ToolExecutionError("generateExecutiveBrief", error);
    }
  }
}
