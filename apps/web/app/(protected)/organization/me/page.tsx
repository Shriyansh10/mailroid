"use client";

import { usePeriod } from "../use-period";
import { PeriodSelect } from "../period-select";
import { SelfView } from "../bento/self-view";

/**
 * A manager's own numbers, as the people above them see them. Only the `my*`
 * queries — identity comes from the session, never from the URL.
 */
export default function OrganizationMePage() {
  const [days, setDays] = usePeriod();
  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-(--ob-muted)">Your numbers</h2>
        <PeriodSelect value={days} onChange={setDays} />
      </div>
      <SelfView days={days} />
    </div>
  );
}
