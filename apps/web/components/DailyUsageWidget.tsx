"use client";

import React, { useState, useEffect } from "react";
import { Progress } from "@web/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@web/components/ui/dialog";
import { Button } from "@web/components/ui/button";
import { Textarea } from "@web/components/ui/textarea";
import { SparklesIcon, CheckCircleIcon, AlertTriangleIcon, Loader2Icon } from "lucide-react";

interface UsageStats {
  actionCount: number;
  limit: number;
  remaining: number;
  unlocked: boolean;
  feedbackUnlocks: number;
}

export function DailyUsageWidget({ dark = false }: { dark?: boolean }) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchUsage = async () => {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/usage", {
        headers: {
          "x-user-timezone": timezone,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (error) {
      console.error("[DailyUsageWidget] Failed to fetch usage stats:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsage();

    // Listen to custom events to automatically refresh usage status
    const refreshHandler = () => {
      fetchUsage();
    };

    window.addEventListener("assistant-action-completed", refreshHandler);
    return () => {
      window.removeEventListener("assistant-action-completed", refreshHandler);
    };
  }, []);

  const handleSubmitFeedback = async () => {
    if (feedbackText.trim().length < 30) {
      setErrorMsg("Feedback must be at least 30 characters long.");
      return;
    }
    if (feedbackText.trim().length > 2000) {
      setErrorMsg("Feedback must be less than 2000 characters.");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-timezone": timezone,
        },
        body: JSON.stringify({ feedbackText }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMsg(data.error || "Failed to submit feedback.");
      } else {
        if (data.approved) {
          setSuccessMsg("✨ Thank you! Your feedback was approved. Daily limit extended to 20 actions!");
          setFeedbackText("");
          // Refetch usage stats
          fetchUsage();
          // Dispatch global refresh
          window.dispatchEvent(new Event("assistant-action-completed"));
          setTimeout(() => {
            setModalOpen(false);
            setSuccessMsg(null);
          }, 3000);
        } else {
          // It was evaluated but rejected
          setErrorMsg(data.reason || "Your feedback did not meet the quality criteria. Please be more specific.");
        }
      }
    } catch (error) {
      setErrorMsg("Failed to communicate with feedback evaluation server.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className={`p-4 rounded-xl border ${dark ? "border-slate-800 bg-slate-900/50 text-slate-400" : "border-slate-200 bg-slate-50 text-slate-600"} text-xs flex items-center justify-center gap-2`}>
        <Loader2Icon className="size-3.5 animate-spin" />
        <span>Loading assistant limits…</span>
      </div>
    );
  }

  if (!stats) return null;

  // Bypass widget if user is whitelisted (limit is 9999)
  if (stats.limit > 100) {
    return (
      <div className={`p-3 rounded-xl border ${dark ? "border-slate-800 bg-slate-900/40 text-slate-400" : "border-slate-200 bg-slate-50/50 text-slate-500"} text-xs text-center`}>
        🛡️ Unlimited Assistant Access
      </div>
    );
  }

  const { actionCount, limit, remaining, unlocked } = stats;
  const progressPercent = Math.min(100, (actionCount / limit) * 100);

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Mini Widget Card */}
      <div className={`p-4 rounded-xl border transition-all duration-300 ${
        dark 
          ? "border-slate-800 bg-slate-900/50 text-slate-300" 
          : "border-slate-200 bg-slate-50 text-slate-800"
      }`}>
        <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
          <span>Assistant Usage</span>
          <span className="tabular-nums">{actionCount} / {limit} used</span>
        </div>

        <Progress value={progressPercent} className="h-1.5 mb-2" />

        <div className="flex justify-between items-center text-[10px] text-muted-foreground">
          {actionCount >= limit ? (
            <span className="text-red-500 font-medium">Daily limit reached</span>
          ) : (
            <span>{remaining} remaining today</span>
          )}

          {unlocked && (
            <span className="text-teal-600 dark:text-teal-400 font-semibold flex items-center gap-0.5">
              ✨ Bonus unlocked
            </span>
          )}
        </div>
      </div>

      {/* Beta feedback prompt at 10/10 limit */}
      {actionCount >= 10 && !unlocked && (
        <div className={`p-4 rounded-xl border border-dashed flex flex-col gap-2.5 ${
          dark
            ? "border-[#4D4D4F] bg-[#2A2B32] text-slate-300"
            : "border-indigo-200 bg-indigo-50/50 text-slate-700"
        }`}>
          <div className="text-xs font-bold flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
            <SparklesIcon className="size-3.5" />
            🎯 You&apos;re helping shape Mailroid
          </div>
          <p className="text-[11px] leading-relaxed">
            You&apos;ve used your first 10 assistant actions today. Share a bug report, feature request, or product suggestion to unlock 10 more assistant actions.
          </p>
          <div className="text-[10px] space-y-0.5 opacity-90 pl-1.5 border-l-2 border-indigo-400">
            <div>• Something confusing in the UI</div>
            <div>• A workflow that feels slow</div>
            <div>• A bug you encountered</div>
            <div>• A feature you&apos;d like added</div>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setErrorMsg(null);
              setSuccessMsg(null);
              setModalOpen(true);
            }}
            className="w-full text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white mt-1 h-8 rounded-lg"
          >
            Submit Feedback
          </Button>
        </div>
      )}

      {/* Thank you message at 20/20 limit */}
      {actionCount >= 20 && (
        <div className={`p-4 rounded-xl border border-dashed text-center flex flex-col gap-1.5 ${
          dark
            ? "border-emerald-800 bg-emerald-950/20 text-emerald-300"
            : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>
          <p className="text-[11px] leading-relaxed font-serif">
            Thank you for testing out Mailroid! I hope you had a great time, see you tomorrow.
          </p>
        </div>
      )}

      {/* Feedback Submission Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Share Beta Feedback</DialogTitle>
            <DialogDescription>
              Help us improve Mailroid. Submit constructive feedback, bugs, feature requests, or UI observations to unlock 10 additional assistant actions for today.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            <Textarea
              placeholder="I noticed that the calendar drag-and-drop works great, but it would be helpful if the events displayed the timezone information explicitly on the dashboard card..."
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              className="min-h-[120px] text-sm text-slate-800"
              maxLength={2000}
              disabled={submitting}
            />

            <div className="flex justify-between items-center text-xs">
              <span className={feedbackText.trim().length >= 30 ? "text-slate-500" : "text-amber-600 font-medium"}>
                {feedbackText.trim().length} / 30 characters minimum
              </span>
              <span className="text-slate-400">Max 2000</span>
            </div>

            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-start gap-2">
                <AlertTriangleIcon className="size-4 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg flex items-start gap-2">
                <CheckCircleIcon className="size-4 shrink-0 mt-0.5" />
                <span>{successMsg}</span>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setModalOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitFeedback}
              disabled={submitting || feedbackText.trim().length < 30 || feedbackText.trim().length > 2000}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {submitting ? (
                <>
                  <Loader2Icon className="size-4 animate-spin mr-1.5" />
                  Evaluating...
                </>
              ) : (
                "Submit Feedback"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
