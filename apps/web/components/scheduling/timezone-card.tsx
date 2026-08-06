"use client";

import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@web/components/ui/card";
import { Button } from "@web/components/ui/button";
import {
  useSchedulingSettings,
  useUpdateSchedulingSettings,
} from "@web/hooks/api/scheduling";

/**
 * Every meeting time Mailroid suggests or books, and everything the AI
 * routes resolve as "the user's timezone," reads this stored value —
 * shared between Settings → Scheduling and onboarding so both save through
 * the same mutation and never drift into two different UIs for one setting.
 */
export function TimezoneCard() {
  const settingsQuery = useSchedulingSettings();
  const updateSettings = useUpdateSchedulingSettings();

  // The browser's zone is only a suggestion until the user saves it — after
  // that the stored value wins, including on a borrowed laptop or a VPN.
  const browserZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );
  const storedZone = settingsQuery.data?.timeZone;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timezone</CardTitle>
        <CardDescription>
          Every meeting time Mailroid suggests or books is in this zone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-sm font-medium">{storedZone ?? browserZone}</span>
            <span className="text-xs text-muted-foreground">
              {storedZone
                ? "Saved — used even if you sign in from elsewhere."
                : "Detected from this browser. Save it to make it stick."}
            </span>
          </div>
          {storedZone !== browserZone && (
            <Button
              variant="outline"
              size="sm"
              disabled={updateSettings.isPending}
              onClick={() => updateSettings.mutate({ timeZone: browserZone })}
            >
              {storedZone ? `Change to ${browserZone}` : "Save"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
