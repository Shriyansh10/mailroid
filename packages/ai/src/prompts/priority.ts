import { deepseek, DEEPSEEK_CHAT_MODEL } from "../client.ts";

export interface PriorityClassificationResult {
  priority: "HIGH" | "MEDIUM" | "LOW";
  priorityScore: number; // 0.0 to 1.0
  priorityReason: string;
  isActionRequired: boolean;
  isReplyNeeded: boolean;
}

const SYSTEM_PROMPT = `
You are an executive assistant AI tasked with triaging incoming emails.
Your goal is to determine the priority level of an email based on the sender, subject, and content snippet.

Rules for Priority:
- HIGH: Urgent issues, critical alerts, emails from executives/VIPs, meetings within 24h, or direct requests requiring immediate action.
- MEDIUM: Standard business correspondence, normal requests, status updates.
- LOW: Newsletters, marketing, automated non-critical notifications, CC'd emails requiring no action.

You must output a strictly valid JSON object matching this schema, without any markdown formatting or extra text:
{
  "priority": "HIGH" | "MEDIUM" | "LOW",
  "priorityScore": number (0.0 to 1.0),
  "priorityReason": "1 sentence explanation",
  "isActionRequired": boolean,
  "isReplyNeeded": boolean
}
`;

export async function classifyEmailPriority(
  sender: string,
  subject: string,
  snippet: string
): Promise<PriorityClassificationResult | null> {
  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_CHAT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Sender: ${sender}\nSubject: ${subject}\nSnippet: ${snippet}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as PriorityClassificationResult;
    return {
      priority: parsed.priority || "MEDIUM",
      priorityScore: typeof parsed.priorityScore === "number" ? parsed.priorityScore : 0.5,
      priorityReason: parsed.priorityReason || "No reasoning provided.",
      isActionRequired: Boolean(parsed.isActionRequired),
      isReplyNeeded: Boolean(parsed.isReplyNeeded),
    };
  } catch (err) {
    console.error("[AI] classifyEmailPriority error:", err);
    return null;
  }
}
