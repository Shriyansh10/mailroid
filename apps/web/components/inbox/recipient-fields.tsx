"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { XIcon } from "lucide-react";

import { cn } from "@web/lib/utils";
import {
  dedupeAddresses,
  isValidAddress,
  joinAddresses,
  parseAddressList,
  removeAddresses,
} from "@web/lib/email-addresses";

export type RecipientField = "to" | "cc" | "bcc";

export interface RecipientValues {
  to: string;
  cc: string;
  bcc: string;
}

export interface RecipientFieldsHandle {
  /** Put the cursor in one row — used to land on the address that blocked a send. */
  focusField: (field: RecipientField) => void;
}

interface RecipientFieldsProps {
  values: RecipientValues;
  /** Emits all three lines at once: a single edit can move an address between them. */
  onChange: (next: RecipientValues) => void;
  disabled?: boolean;
  autoFocusField?: RecipientField;
  /** Tighter rows for the inline reply box, which sits inside a thread. */
  compact?: boolean;
}

const FIELD_ORDER: RecipientField[] = ["to", "cc", "bcc"];
const LABELS: Record<RecipientField, string> = { to: "To", cc: "Cc", bcc: "Bcc" };

/**
 * Precedence when the same person lands on two lines: **To beats Cc beats
 * Bcc**. Adding someone to Cc who is already in To drops the Cc chip, never
 * the To one — the stronger line keeps them. The practical consequence, which
 * matches Gmail: moving someone from To to Cc means removing them from To
 * first, otherwise the Cc entry is a no-op.
 */
function applyPrecedence(lists: Record<RecipientField, string[]>): RecipientValues {
  const to = dedupeAddresses(lists.to);
  const cc = removeAddresses(dedupeAddresses(lists.cc), to);
  const bcc = removeAddresses(dedupeAddresses(lists.bcc), [...to, ...cc]);
  return { to: joinAddresses(to), cc: joinAddresses(cc), bcc: joinAddresses(bcc) };
}

/** The first line holding an unsendable address, if any. */
export function firstInvalidRecipientField(
  values: RecipientValues,
): RecipientField | undefined {
  return FIELD_ORDER.find((field) =>
    parseAddressList(values[field]).some((address) => !isValidAddress(address)),
  );
}

/** Every address across To and Cc, deduped. Bcc is never included — see callers. */
export function visibleRecipients(values: RecipientValues): string[] {
  return dedupeAddresses([
    ...parseAddressList(values.to),
    ...parseAddressList(values.cc),
  ]);
}

/**
 * Gmail-like To / Cc / Bcc editing: addresses become removable chips, and the
 * Cc and Bcc rows stay hidden behind links on the To row until they're wanted.
 *
 * The comma-joined strings are the single source of truth — chips are derived
 * by parsing them on every render, so there is no chip-vs-string state to fall
 * out of sync. Only the half-typed text in each row is local state.
 *
 * Validation is deliberately late: a malformed address still becomes a chip
 * (outlined in red) rather than being rejected mid-typing, which would fight
 * the user as they type. Sending is what blocks — see
 * firstInvalidRecipientField, used by both compose surfaces.
 */
export const RecipientFields = forwardRef<RecipientFieldsHandle, RecipientFieldsProps>(
  function RecipientFields(
    { values, onChange, disabled, autoFocusField, compact },
    ref,
  ) {
    const [pending, setPending] = useState<Record<RecipientField, string>>({
      to: "",
      cc: "",
      bcc: "",
    });
    const [showCc, setShowCc] = useState(false);
    const [showBcc, setShowBcc] = useState(false);

    const inputs = useRef<Record<RecipientField, HTMLInputElement | null>>({
      to: null,
      cc: null,
      bcc: null,
    });

    const lists = useMemo(
      () => ({
        to: parseAddressList(values.to),
        cc: parseAddressList(values.cc),
        bcc: parseAddressList(values.bcc),
      }),
      [values.to, values.cc, values.bcc],
    );

    // Reveal a row whose value arrives already populated — reopening a
    // reply-all, or a draft saved with a Bcc, has to show what it will send.
    // One-way on purpose: clearing the last Cc chip leaves the row open so the
    // user can type another, exactly like Gmail.
    useEffect(() => {
      if (lists.cc.length > 0) setShowCc(true);
      if (lists.bcc.length > 0) setShowBcc(true);
    }, [lists.cc.length, lists.bcc.length]);

    useImperativeHandle(ref, () => ({
      focusField(field) {
        if (field === "cc") setShowCc(true);
        if (field === "bcc") setShowBcc(true);
        // After the row has had a chance to mount.
        setTimeout(() => inputs.current[field]?.focus(), 0);
      },
    }));

    useEffect(() => {
      if (autoFocusField) inputs.current[autoFocusField]?.focus();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const commit = (field: RecipientField, text: string) => {
      const added = parseAddressList(text);
      if (added.length === 0) {
        setPending((p) => ({ ...p, [field]: "" }));
        return;
      }
      onChange(applyPrecedence({ ...lists, [field]: [...lists[field], ...added] }));
      setPending((p) => ({ ...p, [field]: "" }));
    };

    const removeAt = (field: RecipientField, index: number) => {
      const next = lists[field].filter((_, i) => i !== index);
      onChange(applyPrecedence({ ...lists, [field]: next }));
    };

    const handleKeyDown = (field: RecipientField) => (e: React.KeyboardEvent<HTMLInputElement>) => {
      const text = pending[field];

      if (e.key === "," || e.key === ";" || e.key === "Enter") {
        // Enter especially: without this it submits the compose form with a
        // half-entered recipient sitting in the input, unsent and invisible.
        e.preventDefault();
        commit(field, text);
        return;
      }
      if (e.key === "Tab" && text.trim()) {
        // Commit, but let Tab move focus as usual.
        commit(field, text);
        return;
      }
      if (e.key === "Backspace" && text === "" && lists[field].length > 0) {
        e.preventDefault();
        removeAt(field, lists[field].length - 1);
      }
    };

    const handlePaste = (field: RecipientField) => (e: React.ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData("text");
      if (!/[,;\n]/.test(text)) return; // single address: let it type normally
      e.preventDefault();
      commit(field, `${pending[field]}${text}`);
    };

    const renderRow = (field: RecipientField, trailing?: React.ReactNode) => (
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "shrink-0 pt-1.5 text-muted-foreground",
            compact ? "text-xs w-7" : "text-sm w-8",
          )}
        >
          {LABELS[field]}
        </span>
        <div
          onClick={() => inputs.current[field]?.focus()}
          className={cn(
            "flex-1 min-w-0 flex flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
            compact ? "min-h-8" : "min-h-9",
            disabled && "opacity-50 pointer-events-none",
          )}
        >
          {lists[field].map((address, index) => {
            const invalid = !isValidAddress(address);
            return (
              <span
                key={`${address}-${index}`}
                title={invalid ? `${address} is not a valid email address` : address}
                className={cn(
                  "inline-flex max-w-56 items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs",
                  invalid
                    ? "border border-destructive bg-destructive/10 text-destructive"
                    : "bg-muted text-foreground",
                )}
              >
                <span className="truncate">{address}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAt(field, index);
                  }}
                  className="shrink-0 rounded-full p-0.5 hover:bg-foreground/10"
                  title={`Remove ${address}`}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            );
          })}
          <input
            ref={(el) => {
              inputs.current[field] = el;
            }}
            value={pending[field]}
            onChange={(e) => setPending((p) => ({ ...p, [field]: e.target.value }))}
            onKeyDown={handleKeyDown(field)}
            onPaste={handlePaste(field)}
            // Clicking Send blurs this input first, so anything typed but not
            // yet committed still makes it onto the message.
            onBlur={() => commit(field, pending[field])}
            disabled={disabled}
            placeholder={lists[field].length === 0 ? "recipient@example.com" : ""}
            className="min-w-32 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {trailing}
      </div>
    );

    const toggle = (label: string, onClick: () => void) => (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="pt-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {label}
      </button>
    );

    return (
      <div className="space-y-1.5">
        {renderRow(
          "to",
          (!showCc || !showBcc) && (
            <div className="flex shrink-0 items-start gap-2">
              {!showCc && toggle("Cc", () => {
                setShowCc(true);
                setTimeout(() => inputs.current.cc?.focus(), 0);
              })}
              {!showBcc && toggle("Bcc", () => {
                setShowBcc(true);
                setTimeout(() => inputs.current.bcc?.focus(), 0);
              })}
            </div>
          ),
        )}
        {showCc && renderRow("cc")}
        {showBcc && renderRow("bcc")}
      </div>
    );
  },
);
