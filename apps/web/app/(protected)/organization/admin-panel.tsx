"use client";

import { useState } from "react";
import { toast } from "sonner";
import { TrashIcon, UserPlusIcon } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";

import {
  useAddMember,
  useOrgMembers,
  useRemoveMember,
  useSetManager,
} from "@web/hooks/api/organization";

const NO_MANAGER = "__none__";

/**
 * Owner-only administration: who is in the organization and who they report to.
 *
 * Adding someone who has never used Mailroid is intentional and normal — they
 * become a member immediately and show as uncovered until they sign up with the
 * same address. There is no invitation to accept.
 */
export function AdminPanel({ organizationId }: { organizationId: string }) {
  const { data: members } = useOrgMembers(organizationId);
  const addMember = useAddMember();
  const setManager = useSetManager();
  const removeMember = useRemoveMember();

  const [email, setEmail] = useState("");
  const [managerEmail, setManagerEmail] = useState<string>(NO_MANAGER);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    try {
      await addMember.mutateAsync({
        organizationId,
        email: trimmed,
        role: "MEMBER",
        managerEmail: managerEmail === NO_MANAGER ? null : managerEmail,
      });
      setEmail("");
      toast.success(`${trimmed} added.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add member.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>
          Add anyone by work address. They can be added before they have a Mailroid
          account — they will show as not connected until they sign up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="member-email">Work email</Label>
            <Input
              id="member-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@company.com"
              className="w-64"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="member-manager">Reports to</Label>
            <Select value={managerEmail} onValueChange={setManagerEmail}>
              <SelectTrigger id="member-manager" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_MANAGER}>Nobody yet</SelectItem>
                {members?.map((m) => (
                  <SelectItem key={m.email} value={m.email}>
                    {m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleAdd} disabled={addMember.isPending} className="gap-1.5">
            <UserPlusIcon className="size-4" />
            {addMember.isPending ? "Adding…" : "Add"}
          </Button>
        </div>

        <div className="flex flex-col divide-y rounded-lg border">
          {members?.map((member) => (
            <div key={member.email} className="flex items-center gap-3 p-3">
              <span className="flex-1 text-sm font-medium">{member.email}</span>
              <span className="text-xs text-muted-foreground">{member.role}</span>

              <Select
                value={member.managerEmail ?? NO_MANAGER}
                onValueChange={async (value) => {
                  try {
                    await setManager.mutateAsync({
                      organizationId,
                      subordinateEmail: member.email,
                      managerEmail: value === NO_MANAGER ? null : value,
                    });
                  } catch (error) {
                    // Cycles and non-members are refused by the server; showing
                    // the reason is the difference between "it broke" and
                    // "that would make the chart circular".
                    toast.error(
                      error instanceof Error ? error.message : "Could not set manager.",
                    );
                  }
                }}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>No manager</SelectItem>
                  {members
                    .filter((m) => m.email !== member.email)
                    .map((m) => (
                      <SelectItem key={m.email} value={m.email}>
                        {m.email}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>

              <Button
                variant="ghost"
                size="icon"
                onClick={async () => {
                  try {
                    await removeMember.mutateAsync({ organizationId, email: member.email });
                    toast.success(`${member.email} removed.`);
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : "Could not remove member.",
                    );
                  }
                }}
              >
                <TrashIcon className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
