"use client";

import { createContext, useContext } from "react";

export type OrgRole = "OWNER" | "MEMBER";

export interface ActiveOrg {
  organizationId: string;
  name: string;
  role: OrgRole;
  isOwner: boolean;
}

const OrgContext = createContext<ActiveOrg | null>(null);

export const OrgProvider = OrgContext.Provider;

/**
 * Only usable below `OrgShell`, which renders its children exclusively once
 * an active licensed organization is resolved — so a missing context here is
 * a wiring bug, not a state the UI needs to handle gracefully.
 */
export function useOrg(): ActiveOrg {
  const org = useContext(OrgContext);
  if (!org) throw new Error("useOrg() called outside OrgProvider.");
  return org;
}
