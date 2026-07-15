"use client";

import { useRouter } from "next/navigation";
import { ArrowLeftIcon, KeyboardIcon } from "lucide-react";
import { Button } from "@web/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@web/components/ui/card";
import { Kbd, KbdGroup } from "@web/components/ui/kbd";

type Shortcut = {
  keys: string[];
  description: string;
};

type ShortcutGroup = {
  title: string;
  shortcuts: Shortcut[];
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Inbox navigation",
    shortcuts: [
      { keys: ["j"], description: "Select the next email" },
      { keys: ["k"], description: "Select the previous email" },
      { keys: ["Enter"], description: "Open the selected email" },
      { keys: ["o"], description: "Open the selected email" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { keys: ["c"], description: "Compose a new email" },
      { keys: ["e"], description: "Archive the selected email" },
      { keys: ["/"], description: "Focus the search box" },
    ],
  },
];

export default function ShortcutsPage() {
  const router = useRouter();

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
            <KeyboardIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Keyboard Shortcuts</h1>
            <p className="text-sm text-muted-foreground">Move faster through your inbox without touching the mouse.</p>
          </div>
        </div>

        {SHORTCUT_GROUPS.map((group) => (
          <Card key={group.title}>
            <CardHeader>
              <CardTitle>{group.title}</CardTitle>
              <CardDescription>
                Available while a category, priority, or search list is open in the inbox.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {group.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.description}
                  className="flex items-center justify-between gap-4 py-1"
                >
                  <span className="text-sm text-foreground">{shortcut.description}</span>
                  <KbdGroup>
                    {shortcut.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}

        <p className="text-xs text-muted-foreground">
          Shortcuts are disabled while typing in a text field or while the compose window is open.
        </p>
      </div>
    </div>
  );
}
