import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
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

      return { briefing };
    } catch (error) {
      console.error("[executor:generateExecutiveBrief] FAILED", error);
      throw new ToolExecutionError("generateExecutiveBrief", error);
    }
  }
}
