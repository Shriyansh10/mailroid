"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { ArrowLeftIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { Button } from "@web/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@web/components/ui/card";
import { Label } from "@web/components/ui/label";
import { Switch } from "@web/components/ui/switch";

export default function AppearancePage() {
  const router = useRouter();
  const { theme, setTheme, systemTheme } = useTheme();

  // The server has no way to know the stored theme, so the first client render
  // must match the server's markup or React screams about a hydration mismatch.
  // Render the control only once mounted, when the real theme is readable.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // "system" is a real stored value, not a third switch position — resolve it to
  // whatever the OS currently reports so the toggle reflects what's on screen.
  const resolved = theme === "system" ? systemTheme : theme;
  const isDark = resolved === "dark";

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
            <PaletteIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Appearance</h1>
            <p className="text-sm text-muted-foreground">Choose how Mailroid looks on this device.</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>
              Your choice is saved in this browser and applies the next time you open Mailroid.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {isDark ? (
                  <MoonIcon className="size-4 text-muted-foreground" />
                ) : (
                  <SunIcon className="size-4 text-muted-foreground" />
                )}
                <div className="flex flex-col">
                  <Label htmlFor="dark-mode" className="text-sm font-medium">
                    Dark mode
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {mounted
                      ? isDark
                        ? "Dark theme is on."
                        : "Light theme is on."
                      : "Loading your preference…"}
                  </span>
                </div>
              </div>
              <Switch
                id="dark-mode"
                checked={mounted ? isDark : false}
                disabled={!mounted}
                onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                aria-label="Toggle dark mode"
              />
            </div>

            {mounted && theme === "system" && (
              <p className="text-xs text-muted-foreground border-t pt-4">
                Currently following your system setting. Flipping the switch pins Mailroid to a
                single theme.
              </p>
            )}

            {mounted && theme !== "system" && (
              <div className="flex items-center justify-between gap-4 border-t pt-4">
                <span className="text-xs text-muted-foreground">
                  Pinned to {theme}, ignoring your system setting.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-8"
                  onClick={() => setTheme("system")}
                >
                  Match system
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
