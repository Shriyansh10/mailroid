"use client";

import {
  TOPIC,
  TOPIC_LABELS,
  TOPIC_WEIGHT,
  TOPIC_IMPLIED_MEANING,
  sanitizeTagInput,
  type PriorityProfile,
} from "@repo/shared";
import { cn } from "@web/lib/utils";
import { TagInput } from "./tag-input";

type TopicEntry = PriorityProfile["content"]["importantTopics"][number];

const WEIGHT_OPTIONS = [
  { value: TOPIC_WEIGHT.HIGH, label: "High" },
  { value: TOPIC_WEIGHT.MEDIUM, label: "Medium" },
  { value: TOPIC_WEIGHT.LOW, label: "Low" },
] as const;

// Topic chips; selecting one expands a weight selector (which topic matters
// most) and an optional custom-keywords input that extends the topic's
// built-in vocabulary.
export function TopicPicker({
  value,
  onChange,
}: {
  value: TopicEntry[];
  onChange: (next: TopicEntry[]) => void;
}) {
  const selectedIds = value.map((t) => t.id);

  const toggle = (id: TopicEntry["id"]) => {
    if (selectedIds.includes(id)) {
      onChange(value.filter((t) => t.id !== id));
    } else {
      onChange([
        ...value,
        { id, weight: TOPIC_WEIGHT.MEDIUM, customKeywords: [] },
      ]);
    }
  };

  const update = (id: TopicEntry["id"], patch: Partial<TopicEntry>) => {
    onChange(value.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {Object.values(TOPIC).map((id) => {
          const selected = selectedIds.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => toggle(id)}
              title={TOPIC_IMPLIED_MEANING[id]}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-foreground/80 hover:bg-muted",
              )}
            >
              {TOPIC_LABELS[id]}
            </button>
          );
        })}
      </div>

      {value.map((topic) => (
        <div key={topic.id} className="rounded-lg border bg-card/50 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{TOPIC_LABELS[topic.id]}</span>
            <div className="flex gap-1">
              {WEIGHT_OPTIONS.map((w) => (
                <button
                  key={w.value}
                  type="button"
                  aria-pressed={topic.weight === w.value}
                  onClick={() => update(topic.id, { weight: w.value })}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
                    topic.weight === w.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:bg-muted",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Covers {TOPIC_IMPLIED_MEANING[topic.id]}. Add your own words below (optional).
          </p>
          <TagInput
            value={topic.customKeywords}
            onChange={(customKeywords) => update(topic.id, { customKeywords })}
            sanitize={sanitizeTagInput}
            placeholder='e.g. "leetcode", "hackerrank"'
            max={10}
          />
        </div>
      ))}
    </div>
  );
}
