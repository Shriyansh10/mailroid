"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@web/lib/utils";
import { useOrg } from "./org-context";

/**
 * Overview / People / My numbers / Manage — the discoverability fix: a manager
 * should meet every screen the moment they land, not scroll past everything
 * stacked on one page.
 *
 * Two separate capabilities decide it. `canViewTeam` (from the server, the same
 * flag the Overview page renders by) adds People and My numbers; for someone
 * with nobody in scope, Overview already *is* their numbers. `isOwner` adds
 * Manage, because administering is not the same thing as having reports.
 */
export function OrgNav() {
  const org = useOrg();
  const pathname = usePathname();

  const tabs = [
    { href: "/organization", label: "Overview" },
    ...(org.canViewTeam
      ? [
          { href: "/organization/people", label: "People" },
          { href: "/organization/me", label: "My numbers" },
        ]
      : []),
    ...(org.isOwner ? [{ href: "/organization/manage", label: "Manage" }] : []),
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-(--ob-line)">
      {tabs.map((tab) => {
        // People's drill-down route (/organization/people/[email]) should
        // still highlight the People tab.
        const active =
          tab.href === "/organization"
            ? pathname === "/organization"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
              active
                ? "border-(--ob-accent) text-(--ob-ink)"
                : "border-transparent text-(--ob-muted) hover:text-(--ob-ink)",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
