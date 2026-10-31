"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftIcon, Loader2Icon, UserCogIcon } from "lucide-react";

import { trpc } from "@web/trpc/client";
import { authClient } from "@web/lib/auth-client";
import { Button } from "@web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@web/components/ui/card";
import { Label } from "@web/components/ui/label";
import { Textarea } from "@web/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@web/components/ui/radio-group";

/**
 * Account settings — and the only place a user can ask for their account to be
 * deleted.
 *
 * Asking is all a user can do (D-012). The request goes to the Mailroid team;
 * if the user belongs to an organization, the team confirms with it first.
 * Nothing here deletes anything, and the copy must never suggest it does.
 */
export default function AccountSettingsPage() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const utils = trpc.useUtils();
  const mine = trpc.accountDeletion.mine.useQuery();
  const request = trpc.accountDeletion.request.useMutation({
    onSuccess: () => {
      toast.success("Request sent. We'll be in touch.");
      void utils.accountDeletion.mine.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const withdraw = trpc.accountDeletion.withdraw.useMutation({
    onSuccess: () => {
      toast.success("Request withdrawn.");
      void utils.accountDeletion.mine.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [kind, setKind] = useState<"DEPARTURE" | "PRIVACY_ERASURE">("DEPARTURE");
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");

  const open = mine.data && !["WITHDRAWN", "REJECTED", "CANCELLED", "COMPLETED"].includes(mine.data.status);

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
          Back to inbox
        </Button>

        <div className="flex items-center gap-3">
          <UserCogIcon className="size-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Account</h1>
            <p className="text-sm text-muted-foreground">{session?.user?.email}</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Delete your account</CardTitle>
            <CardDescription>
              Send a request to the Mailroid team to delete your account and the data Mailroid holds for you. Your
              request will be reviewed. If you&apos;re part of an organization, we&apos;ll confirm with them first.
              Mail and calendar data in your Google account is not affected.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {mine.isLoading ? (
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            ) : open ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm">{mine.data!.message}</p>
                <p className="text-xs text-muted-foreground">
                  Requested {new Date(mine.data!.requestedAt).toLocaleString()}
                </p>
                {mine.data!.status === "SUBMITTED" && (
                  <p className="text-xs text-muted-foreground">
                    Nothing has been deleted. Your account works as usual until the team acts on the request, and you can
                    withdraw it until then.
                  </p>
                )}
                {mine.data!.status === "SUBMITTED" && (
                  <Button
                    variant="outline"
                    className="self-start"
                    disabled={withdraw.isPending}
                    onClick={() => withdraw.mutate()}
                  >
                    {withdraw.isPending && <Loader2Icon className="size-4 animate-spin" />}
                    Withdraw request
                  </Button>
                )}
              </div>
            ) : (
              <form
                className="flex flex-col gap-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  request.mutate({ kind, reason, details: details || undefined });
                }}
              >
                {mine.data && <p className="text-xs text-muted-foreground">Previous request: {mine.data.message}</p>}
                <div className="flex flex-col gap-2">
                  <Label>Why are you asking?</Label>
                  <RadioGroup value={kind} onValueChange={(v) => setKind(v as typeof kind)} className="gap-2">
                    <label className="flex items-start gap-2 text-sm">
                      <RadioGroupItem value="DEPARTURE" className="mt-0.5" />
                      <span>I&apos;m leaving, or no longer need Mailroid</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <RadioGroupItem value="PRIVACY_ERASURE" className="mt-0.5" />
                      <span>I want my personal data erased (privacy request)</span>
                    </label>
                  </RadioGroup>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reason">Reason</Label>
                  <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="details">Anything else we should know? (optional)</Label>
                  <Textarea id="details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} rows={3} />
                </div>
                <Button type="submit" variant="destructive" className="self-start" disabled={request.isPending || reason.trim().length < 3}>
                  {request.isPending && <Loader2Icon className="size-4 animate-spin" />}
                  Request account deletion
                </Button>
                <p className="text-xs text-muted-foreground">
                  This sends a request; it doesn&apos;t delete anything. Your account keeps working while the team reviews
                  it, and you can withdraw it until they act on it. Once deletion starts you are signed out and can&apos;t
                  sign back in.
                </p>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
