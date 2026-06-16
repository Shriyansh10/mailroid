// ── Injection match ─────────────────────────────────────────────────────

export interface PromptInjectionMatch {
  pattern: string;
  start: number;
  end: number;
}

// ── Instruction override patterns ───────────────────────────────────────

const INSTRUCTION_OVERRIDE = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|the\s+above)\s+instructions?\b/gi,
  /\bignore\s+(?:your|the)\s+(?:system\s+)?prompt\b/gi,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|instructions?)\b/gi,
  /\bforget\s+(?:your|all|everything|the)\s+(?:instructions?|prompt|rules?)\b/gi,
  /\boverride\s+(?:your|the)\s+(?:instructions?|prompt|rules?)\b/gi,
  /\byou\s+are\s+now\s+(?:a|an)\s+(?:different|new)\s+(?:role|persona|assistant|model)\b/gi,
  /\bpretend\s+(?:you\s+are|to\s+be)\b/gi,
  /\bnew\s+(?:system\s+)?instructions?\s*(?::|are|is)\b/gi,
  /\b(?:developer|system)\s+message\s*(?::|is)\b/gi,
];

// ── Tool abuse patterns ─────────────────────────────────────────────────

const TOOL_ABUSE = [
  /\b(?:must|should|please|now|immediately|I\s+need\s+you\s+to)\s+(?:execute|call|run|invoke)\s+(?:a\s+)?(?:tool|function|action)\b/gi,
  /\b(?:execute|call)\s+(?:the\s+)?(?:sendEmail|createEvent|searchEmails|getEvents)\s+(?:tool|function)\b/gi,
  /\b(?:create|send|forward|delete)\s+(?:an?\s+)?email\s+(?:on\s+my\s+behalf|for\s+me|automatically)\b/gi,
  /\b(?:create|schedule)\s+(?:an?\s+)?(?:event|meeting|calendar\s+event)\s+(?:on\s+my\s+behalf|for\s+me|automatically)\b/gi,
  /\bbypass\s+(?:the\s+)?(?:approval|permission|security|firewall)\b/gi,
];

// ── Prompt exfiltration patterns ────────────────────────────────────────

const PROMPT_EXFILTRATION = [
  /\breveal\s+(?:your|the)\s+(?:system\s+)?prompt\b/gi,
  /\breveal\s+(?:your|the)\s+(?:instructions?|secrets?)\b/gi,
  /\btell\s+me\s+(?:your|the)\s+(?:system\s+)?prompt\b/gi,
  /\bshow\s+(?:me\s+)?(?:your|the)\s+(?:instructions?|rules?|prompt)\b/gi,
  /\bwhat\s+(?:are|is)\s+(?:your|the)\s+(?:instructions?|rules?)\b/gi,
  /\boutput\s+(?:your|the)\s+(?:system\s+)?prompt\b/gi,
  /\bprint\s+(?:your|the)\s+(?:instructions?|prompt)\b/gi,
];

// ── Sibling attack patterns ────────────────────────────────────────────

const SIBLING_ATTACK = [
  /\b(?:assistant|system|ai|bot|gpt|llm)\s*(?:,|:)\s*$/gim,
  /\b\[system\]\s*\(/gi,
  /\b\[assistant\]\s*\(/gi,
];

// ── Public API ──────────────────────────────────────────────────────────

export function detectPromptInjection(text: string): PromptInjectionMatch[] {
  if (!text) return [];

  const results: PromptInjectionMatch[] = [];
  const allPatterns = [
    ...INSTRUCTION_OVERRIDE,
    ...TOOL_ABUSE,
    ...PROMPT_EXFILTRATION,
    ...SIBLING_ATTACK,
  ];

  for (const regex of allPatterns) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      results.push({
        pattern: regex.source.slice(0, 80),
        start: m.index,
        end: m.index + m[0].length,
      });
      if (m[0].length === 0) regex.lastIndex++;
    }
  }

  return mergeOverlapping(results);
}

// ── Merge overlapping matches ──────────────────────────────────────────

function mergeOverlapping(matches: PromptInjectionMatch[]): PromptInjectionMatch[] {
  if (matches.length <= 1) return matches;

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const merged: PromptInjectionMatch[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = sorted[i]!;
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
      prev.pattern = `${prev.pattern}|${curr.pattern}`.slice(0, 100);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
