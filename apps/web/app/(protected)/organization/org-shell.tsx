"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftIcon, BuildingIcon } from "lucide-react";

import { useSession } from "@web/lib/auth-client";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";

import { useMyOrganizations, useProvisionOrganization } from "@web/hooks/api/organization";

import { OrgProvider } from "./org-context";
import { OrgNav } from "./org-nav";

/**
 * Resolves the active licensed organization once for every page under
 * /organization, and renders the nav shell around them. Pages below assume
 * `useOrg()` context is available — they never re-resolve the active org
 * themselves.
 */
export function OrgShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session } = useSession();
  const { data: organizations, isLoading } = useMyOrganizations();
  const provision = useProvisionOrganization();

  const [orgName, setOrgName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");

  const isDeveloper = session?.user?.platformRole === "DEVELOPER";
  const licensed = organizations?.filter((o) => o.licensed) ?? [];
  const active = licensed[0] ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
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
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
            <BuildingIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {active?.name ?? "Organization"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Communication metrics for your team. Never anyone&apos;s mail.
            </p>
          </div>
        </div>

        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

        {!isLoading && !active && !isDeveloper ? (
          <Card>
            <CardHeader>
              <CardTitle>No organization yet</CardTitle>
              <CardDescription>
                Organization reporting is enabled by Mailroid for your company. Once
                it is, your team appears here.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {/* Provisioning — platform staff only. The server enforces this too; the
            screen exists so provisioning is something you can show, not a
            mutation someone has to be told about. */}
        {isDeveloper ? (
          <Card>
            <CardHeader>
              <CardTitle>Provision an organization</CardTitle>
              <CardDescription>
                Creates the organization, grants its licence, and makes the named
                person its owner.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="org-name">Company</Label>
                <Input
                  id="org-name"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Acme Ltd"
                  className="w-56"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-owner">Owner email</Label>
                <Input
                  id="org-owner"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="owner@acme.com"
                  className="w-64"
                />
              </div>
              <Button
                disabled={provision.isPending || !orgName.trim() || !ownerEmail.trim()}
                onClick={async () => {
                  try {
                    await provision.mutateAsync({
                      name: orgName.trim(),
                      ownerEmail: ownerEmail.trim(),
                      days: 365,
                    });
                    setOrgName("");
                    setOwnerEmail("");
                    toast.success("Organization provisioned.");
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : "Could not provision.",
                    );
                  }
                }}
              >
                {provision.isPending ? "Creating…" : "Create"}
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {active ? (
          <OrgProvider
            value={{
              organizationId: active.organizationId,
              name: active.name,
              role: active.role,
              isOwner: active.role === "OWNER",
            }}
          >
            <OrgNav />
            {children}
          </OrgProvider>
        ) : null}
      </div>
    </div>
  );
}
