/**
 * Two densities for the meeting fields, so one component can render in both
 * places it belongs.
 *
 * The compose dialog is standard shadcn sizing; the thread column is 9px
 * mono-uppercase labels and `h-8` controls. That difference is entirely class
 * strings — which is exactly why the thread had its own reimplementation of
 * the invite fields, and exactly why the two drifted until the thread's copy
 * lost AM/PM, location and any mention of the meeting it was moving.
 *
 * `default` is deliberately all-empty: passing no density must leave existing
 * markup byte-for-byte unchanged.
 */
export type FieldDensity = "default" | "compact";

export interface FieldClasses {
  /** Field labels and section headings. */
  label: string;
  /** Text inputs and the date trigger. */
  input: string;
  /** The bordered container around the whole group. */
  box: string;
  /** Helper and error lines under a field. */
  note: string;
}

export const fieldClasses: Record<FieldDensity, FieldClasses> = {
  default: {
    label: "",
    input: "",
    box: "p-3 gap-3",
    note: "text-xs",
  },
  compact: {
    label: "text-[9px] font-mono uppercase tracking-wider text-muted-foreground",
    input: "h-8 text-xs font-mono px-2 bg-transparent",
    box: "p-3 gap-2.5",
    note: "text-[10px]",
  },
};
