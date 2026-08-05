"use client";

import { useState } from "react";

export interface ToolListEntry {
  name: string;
  description: string;
  parameters: unknown;
  riskLevel: "safe" | "dangerous";
  requiresApproval: boolean;
}

/**
 * Calls GET /api/tools/list (a direct Next.js route, admin-gated — like
 * /api/tools/execute itself, not tRPC). Throws with the server's error
 * message on a non-2xx.
 */
export function useListTools() {
  const [tools, setTools] = useState<ToolListEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refetch(): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tools/list");
      const data = (await res.json().catch(() => ({}))) as {
        tools?: ToolListEntry[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Couldn't load the tool list.");
      }
      setTools(data.tools ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the tool list.");
    } finally {
      setIsLoading(false);
    }
  }

  return { tools, isLoading, error, refetch };
}

export interface ExecuteToolResult {
  status: string;
  toolName: string;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

/**
 * Calls POST /api/tools/execute directly — the existing admin-gated generic
 * tool-execution endpoint. Returns the raw ToolResult JSON rather than
 * throwing on a non-2xx: 403/404/400 here are meaningful outcomes the panel
 * should display (permission denied, unknown tool, bad args), not exceptions.
 */
export function useExecuteTool() {
  const [isPending, setIsPending] = useState(false);

  async function mutateAsync(input: {
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<ExecuteToolResult> {
    setIsPending(true);
    try {
      const res = await fetch("/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return (await res.json()) as ExecuteToolResult;
    } finally {
      setIsPending(false);
    }
  }

  return { mutateAsync, isPending };
}
