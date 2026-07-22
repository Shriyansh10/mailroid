import type { PriorityProfile } from "./priority-profile.ts";
import {
  GOAL_LABELS,
  TOPIC_LABELS,
  TOPIC_WEIGHT,
  SENDER_CATEGORY_LABELS,
  PREFERENCE_LABELS,
} from "./priority-profile-config.ts";

// User-facing preview shown on the wizard's final step and the Settings
// read-only view: "Based on your answers, I'll prioritize … / I'll usually
// deprioritize …". Same tiering logic as the LLM summary builder, but
// worded for humans. Lives in shared so the browser can import it.
export function buildProfilePreview(profile: PriorityProfile): {
  prioritize: string[];
  deprioritize: string[];
} {
  const prioritize: string[] = [];
  const deprioritize: string[] = [];

  for (const category of profile.senders.categories) {
    prioritize.push(`${SENDER_CATEGORY_LABELS[category]} emails`);
  }
  const weighted = [...profile.content.importantTopics].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.weight] - rank[b.weight];
  });
  for (const topic of weighted) {
    if (topic.weight === TOPIC_WEIGHT.LOW) continue;
    prioritize.push(TOPIC_LABELS[topic.id]!.toLowerCase() + " emails");
  }
  for (const goal of profile.interests.activeGoals) {
    prioritize.push(`emails about ${GOAL_LABELS[goal]!.toLowerCase()}`);
  }
  for (const [key, wanted] of Object.entries(profile.preferences)) {
    const label = PREFERENCE_LABELS[key]!.toLowerCase();
    if (wanted) prioritize.push(label);
    else deprioritize.push(label);
  }
  for (const domain of profile.senders.mutedDomains) {
    deprioritize.push(`everything from ${domain}`);
  }

  const cap = (xs: string[]) => [...new Set(xs)].slice(0, 8);
  return { prioritize: cap(prioritize), deprioritize: cap(deprioritize) };
}
