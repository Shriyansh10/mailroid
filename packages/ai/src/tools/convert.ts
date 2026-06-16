import type { ToolRegistry } from "./registry.ts";
import { z } from "zod";

// ── OpenAI Tool Definition ─────────────────────────────────────────────

export interface OpenAiToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ── Zod → JSON Schema Converter ────────────────────────────────────────

/**
 * Converts a Zod schema to a JSON Schema object suitable for OpenAI's
 * `tools[].function.parameters` field.
 *
 * Handles the subset of Zod types used by our tool input schemas:
 *   - ZodObject
 *   - ZodString (with .min(), .email(), .optional() checks)
 *   - ZodArray (of ZodString)
 *   - ZodOptional (unwraps inner)
 *
 * Tries Zod 4's built-in `toJSONSchema()` first, falls back to manual
 * extraction from the schema's internal definition.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Prefer Zod 4's built-in converter when available
  const zodAny = z as Record<string, unknown>;
  if (typeof zodAny.toJSONSchema === "function") {
    try {
      return (zodAny.toJSONSchema as (s: z.ZodType) => Record<string, unknown>)(schema);
    } catch {
      // Fall through to manual extraction
    }
  }

  return extractJsonSchema(schema);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodDef = any;

function getDef(schema: z.ZodType): ZodDef | undefined {
  const s = schema as unknown as Record<string, unknown>;
  const zod = s._zod as Record<string, unknown> | undefined;
  return (zod?.def ?? s._def) as ZodDef | undefined;
}

function extractJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = getDef(schema);
  if (!def) return { type: "string" };

  const typeName: string = def.typeName ?? def.type ?? "";

  switch (typeName) {
    case "ZodOptional":
      return extractJsonSchema(def.innerType as z.ZodType);

    case "ZodObject": {
      const rawShape: Record<string, z.ZodType> =
        typeof def.shape === "function" ? def.shape() : def.shape;
      if (!rawShape) return { type: "object", properties: {} };

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(rawShape)) {
        const fieldDef = getDef(fieldSchema);
        const fieldTypeName: string = fieldDef?.typeName ?? fieldDef?.type ?? "";

        if (fieldTypeName === "ZodOptional") {
          properties[key] = extractJsonSchema(fieldDef.innerType as z.ZodType);
          // Optional — do NOT add to required
        } else {
          properties[key] = extractJsonSchema(fieldSchema);
          required.push(key);
        }
      }

      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }

    case "ZodString": {
      const result: Record<string, unknown> = { type: "string" };
      const description = def.description as string | undefined;
      if (description) result.description = description;

      const checks: Array<{ kind: string; value?: unknown }> =
        (def.checks as Array<{ kind: string; value?: unknown }>) ?? [];
      for (const check of checks) {
        if (check.kind === "min" && typeof check.value === "number") {
          result.minLength = check.value;
        }
        if (check.kind === "email") {
          result.format = "email";
        }
      }

      return result;
    }

    case "ZodArray": {
      const innerType = def.type as z.ZodType | undefined;
      return {
        type: "array",
        items: innerType ? extractJsonSchema(innerType) : { type: "string" },
      };
    }

    default:
      return { type: "string" };
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Convert all registered tools in a `ToolRegistry` into OpenAI-compatible
 * tool definitions for use in `chat.completions.create({ tools: [...] })`.
 */
export function toOpenAiToolDefs(registry: ToolRegistry): OpenAiToolDef[] {
  const toolNames = registry.list();
  const defs: OpenAiToolDef[] = [];

  for (const name of toolNames) {
    const tool = registry.get(name);
    if (!tool) continue;

    defs.push({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.inputSchema),
      },
    });
  }

  return defs;
}
