"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@web/lib/utils";
import { useOrg } from "./org-context";

const TABS = [
  { href: "/organization", label: "Overview" },
  { href: "/organization/people", label: "People" },
] as const;

/**
 * Overview / People / Manage. Manage only appears for an OWNER — this is
 * the discoverability fix: a manager should meet every screen the moment
 * they land, not scroll past everything stacked on one page.
 */
export function OrgNav() {
  const org = useOrg();
  const pathname = usePathname();

  const tabs = org.isOwner ? [...TABS, { href: "/organization/manage", label: "Manage" }] : TABS;

  return (
    <nav className="flex gap-1 border-b">
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
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
