"use client";

import { Card, CardHeader, CardTitle, CardDescription } from "@web/components/ui/card";

import { useOrg } from "../org-context";
import { AdminPanel } from "../admin-panel";

export default function OrganizationManagePage() {
  const org = useOrg();

  if (!org.isOwner) {
    return (
      <div className="pt-6">
        <Card>
          <CardHeader>
            <CardTitle>Owners only</CardTitle>
            <CardDescription>
              Only an organization owner can manage members and reporting lines.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="pt-6">
      <AdminPanel organizationId={org.organizationId} />
    </div>
  );
}
