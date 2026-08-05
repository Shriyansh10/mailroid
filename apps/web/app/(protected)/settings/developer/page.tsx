"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftIcon, TerminalIcon, PlayIcon } from "lucide-react";

import { useListTools, useExecuteTool } from "@web/hooks/api/tools";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@web/components/ui/card";
import { Badge } from "@web/components/ui/badge";
import { Label } from "@web/components/ui/label";
import { Textarea } from "@web/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";

export default function DeveloperSettingsPage() {
  const router = useRouter();
  const { tools, isLoading, error, refetch } = useListTools();
  const { mutateAsync: executeTool, isPending } = useExecuteTool();

  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("{}");
  const [lastResult, setLastResult] = useState<unknown>(null);

  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTool = useMemo(
    () => tools?.find((t) => t.name === selectedToolName) ?? null,
    [tools, selectedToolName],
  );

  const handleRun = async () => {
    if (!selectedToolName) return;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText || "{}");
    } catch {
      toast.error("Args must be valid JSON.");
      return;
    }

    const result = await executeTool({ toolName: selectedToolName, args });
    setLastResult(result);
    if (result.status === "success") {
      toast.success(`${selectedToolName} ran successfully`);
    } else {
      toast.error(`${selectedToolName} returned "${result.status}"`);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/inbox")}
          className="self-start gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to Inbox
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-lg bg-muted">
            <TerminalIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Developer</h1>
            <p className="text-sm text-muted-foreground">
              Manually invoke a registered Dobbie tool for debugging. Admin-only.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Tool runner</CardTitle>
            <CardDescription>
              Dangerous tools run for real — sending mail or creating a calendar event
              happens exactly as if Dobbie had called it. Check the badge before running.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading tools…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="tool-select">Tool</Label>
                  <Select
                    value={selectedToolName ?? undefined}
                    onValueChange={(value) => {
                      setSelectedToolName(value);
                      setLastResult(null);
                    }}
                  >
                    <SelectTrigger id="tool-select" className="w-full">
                      <SelectValue placeholder="Choose a tool" />
                    </SelectTrigger>
                    <SelectContent>
                      {tools?.map((tool) => (
                        <SelectItem key={tool.name} value={tool.name}>
                          <span className="flex items-center gap-2">
                            {tool.name}
                            <Badge
                              variant={tool.riskLevel === "dangerous" ? "destructive" : "secondary"}
                              className="ml-1"
                            >
                              {tool.riskLevel === "dangerous" ? "Dangerous" : "Safe"}
                            </Badge>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedTool && (
                    <p className="text-xs text-muted-foreground">{selectedTool.description}</p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="tool-args">Arguments (JSON)</Label>
                  <Textarea
                    id="tool-args"
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    rows={6}
                    className="font-mono text-sm"
                    placeholder='{\n  "query": "invoices"\n}'
                  />
                  <p className="text-xs text-muted-foreground">
                    Multi-line JSON is fine — Enter adds a new line here, it never runs the tool.
                  </p>
                </div>

                <Button
                  type="button"
                  className="self-start gap-1.5"
                  disabled={!selectedToolName || isPending}
                  onClick={handleRun}
                >
                  <PlayIcon className="size-3.5" />
                  {isPending ? "Running…" : "Run"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {lastResult !== null && (
          <Card>
            <CardHeader>
              <CardTitle>Result</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs bg-muted rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(lastResult, null, 2)}
              </pre>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
