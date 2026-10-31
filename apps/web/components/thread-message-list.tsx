"use client";

import { useState, useEffect, useMemo, useRef, type RefObject } from "react";
import { ChevronRightIcon, ChevronDownIcon, ImageOffIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@web/components/ui/avatar";
import { parseAddressList } from "@web/lib/email-addresses";
import { AttachmentList, type MessageAttachment } from "@web/components/attachment-list";
import { useMarkAttachmentStored } from "@web/hooks/api/gmail";
import { linkifyText } from "@web/lib/linkify";
import { renderMailHtml, type InlineImage } from "@web/lib/mail-html";

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  /**
   * The message's Cc line, when it had one. There is no `bcc` counterpart on
   * purpose: Gmail strips Bcc from delivered mail, so a received message
   * simply doesn't carry one — only a draft you wrote still does.
   */
  cc?: string;
  subject: string;
  date: string;
  body: string;
  htmlBody: string;
  snippet: string;
  isDraft?: boolean;
  draftId?: string;
  /**
   * Attachments, where the absence of a value is itself information.
   *
   *   an array (even empty) → we know. `[]` means there are none.
   *   null / undefined      → UNKNOWN. This message was synced metadata-only,
   *                           so nothing has ever read its payload.
   *
   * Rendered as two different things on purpose — see AttachmentList.
   */
  attachments?: MessageAttachment[] | null;
  /**
   * Images the HTML body can reference by `cid:`.
   *
   * Separate from `attachments` because inline parts are filtered out of that
   * list at every producing site — a signature logo is body furniture, not a
   * document, and must not earn a chip. Absence here means nothing beyond "no
   * `cid:` can be resolved"; there is no unknown state to distinguish.
   */
  inlineImages?: InlineImage[] | null;
}

export function parseSender(from: string) {
  if (!from) return { name: "Unknown", email: "" };
  const match = from.match(/^([^<]+)<([^>]+)>/);
  if (match && match[1] && match[2]) {
    return {
      name: match[1].replace(/"/g, "").trim(),
      email: match[2].trim(),
    };
  }
  return {
    name: from.split("@")[0] || from,
    email: from,
  };
}

/**
 * Gmail's one-line recipient summary: "to agarwalshriyansh009, Smog" — your
 * own address becomes "me", everyone else is shortened to the part before the
 * @. The full addresses live in the details panel, which is the point of the
 * summary being this short.
 */
function summariseRecipients(header: string | undefined, selfEmail?: string): string {
  const addresses = parseAddressList(header);
  if (addresses.length === 0) return "";
  const self = selfEmail?.toLowerCase();
  return addresses
    .map((address) =>
      address.toLowerCase() === self ? "me" : (address.split("@")[0] || address),
    )
    .join(", ");
}

export function formatMessageDate(dateString: string): string {
  if (!dateString) return "";
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (e) {
    return dateString;
  }
}

/**
 * One message's body: sanitised HTML when there is any, plain text otherwise.
 *
 * Its own component so the sanitise/rewrite pass memoizes per message. Inlined
 * in the parent's map it would re-run for every message on every expand/collapse
 * of any one of them, and this is the expensive part of rendering a thread.
 *
 * "Show images" is per message and deliberately NOT persisted. Remote images in
 * mail are overwhelmingly tracking pixels — opening one tells the sender the
 * message was read, when, and roughly from where. A per-sender or global
 * "always show" setting is a reasonable thing to want and a poor default to
 * infer from one click on one message.
 */
function MessageBody({ msg }: { msg: ThreadMessage }) {
  const [showRemoteImages, setShowRemoteImages] = useState(false);

  const rendered = useMemo(
    () =>
      msg.htmlBody
        ? renderMailHtml(msg.htmlBody, {
            inlineImages: msg.inlineImages,
            showRemoteImages,
          })
        : null,
    [msg.htmlBody, msg.inlineImages, showRemoteImages],
  );

  // `rendered.html` is empty when there was no DOM to sanitise against — see
  // renderMailHtml. Falling through to the text body is the safe branch, not a
  // missing case.
  if (!rendered?.html) {
    return (
      <div className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed break-words">
        {linkifyText(msg.body || msg.snippet)}
      </div>
    );
  }

  return (
    <>
      {/* Only shown when something was actually blocked. A banner offering to
          unblock nothing trains the reader to ignore the banner. */}
      {rendered.blockedCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <ImageOffIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">
            {rendered.blockedCount === 1
              ? "1 remote image was blocked to stop the sender tracking that you opened this."
              : `${rendered.blockedCount} remote images were blocked to stop the sender tracking that you opened this.`}
          </span>
          <button
            type="button"
            onClick={() => setShowRemoteImages(true)}
            className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
          >
            Show images
          </button>
        </div>
      )}
      <div
        // Links in sender HTML carry no styling of their own once sanitised, so
        // they rendered as plain black text — indistinguishable from prose, and
        // unclickable-looking even though they worked. These arbitrary variants
        // style them without touching the sanitiser.
        className="max-w-full break-words text-foreground text-sm [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80 [&_a]:break-all"
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
    </>
  );
}

/**
 * Renders a thread's messages exactly as the full mail view
 * (apps/web/app/(protected)/inbox/[threadId]/page.tsx) renders them —
 * extracted from that page so both it and the assistant's email reference
 * sidebar (email-reference-card.tsx) share one renderer. Deliberately
 * read-only: this is ONLY the message timeline, never the Reply/Forward/
 * Schedule-meeting action bar, which stays in the full thread page.
 *
 * Gmail-style collapse: only the LAST message starts expanded; every earlier
 * one renders as a single summary row until clicked. Each message toggles
 * independently (a Set of expanded ids, not a single "which one's open"
 * value), so expanding one never collapses another — matching Gmail, where
 * you can have several messages open in the same thread at once. There is no
 * per-message read/unread flag in the schema, so this doesn't attempt Gmail's
 * exact "expand last + any unread" rule — last-expanded/rest-collapsed is the
 * agreed simplification.
 *
 * DOMPurify sanitization stays here, non-optional — this renders untrusted
 * HTML email content via dangerouslySetInnerHTML.
 */
export function ThreadMessageList({
  messages: allMessages,
  selfEmail,
  revealRef,
}: {
  messages: ThreadMessage[];
  /** The signed-in address, so recipient summaries can say "me" like Gmail. */
  selfEmail?: string;
  /**
   * Receives a function that expands one message and scrolls it into view —
   * for entry points outside this list (the thread's file strip) that point at
   * a message which may currently be collapsed.
   */
  revealRef?: RefObject<((messageId: string) => void) | null>;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // A preview that loads means the attachment is now in storage; remember it in
  // the cached thread so reopening shows the thumbnail, not "Load preview".
  const markAttachmentStored = useMarkAttachmentStored();

  // Which message has its from/to/cc/date/subject panel open (one at a time).
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);

  // Click anywhere outside closes it. The panel itself stops propagation, so
  // selecting an address inside it doesn't dismiss what you're reading.
  useEffect(() => {
    if (!detailsFor) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element;
      // The caret is excluded, not just the panel: mousedown fires before
      // click, so closing here would let the caret's own handler reopen it and
      // the panel would look stuck open.
      if (target.closest("[data-message-details-toggle]")) return;
      if (!detailsRef.current?.contains(target)) setDetailsFor(null);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [detailsFor]);

  // Drafts are unsent — Gmail groups them into the thread by threadId, but
  // they have no place in a read-only timeline. The thread page renders the
  // trailing draft (if any) as an editable InlineReplyBox instead.
  const messages = useMemo(() => allMessages.filter((m) => !m.isDraft), [allMessages]);

  const lastId = messages[messages.length - 1]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(lastId ? [lastId] : []),
  );

  // A new thread (different message ids) should reopen with only its own
  // last message expanded, not whatever ids happened to be expanded before —
  // otherwise navigating between threads leaks collapse state across them.
  const threadKey = useMemo(() => messages.map((m) => m.id).join(","), [messages]);
  useEffect(() => {
    setExpanded(new Set(lastId ? [lastId] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  // Expanding and scrolling are two steps: the expanded card has to render
  // before there is anything to scroll to.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!revealRef) return;
    revealRef.current = (id: string) => {
      setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      setScrollTo(id);
    };
    return () => {
      revealRef.current = null;
    };
  }, [revealRef]);
  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(`msg-${scrollTo}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTo(null);
  }, [scrollTo, expanded]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {messages.map((msg) => {
        const { name, email } = parseSender(msg.from);
        const initials = name.slice(0, 2).toUpperCase();
        const isExpanded = expanded.has(msg.id);

        if (!isExpanded) {
          return (
            <button
              key={msg.id}
              id={`msg-${msg.id}`}
              type="button"
              onClick={() => toggle(msg.id)}
              className="scroll-mt-4 w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border bg-card hover:bg-muted/40 transition-colors text-left"
            >
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Avatar className="size-7 border border-border shrink-0">
                <AvatarFallback className="bg-muted text-muted-foreground text-[10px] font-mono font-bold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-semibold text-foreground shrink-0">{name}</span>
              <span className="text-sm text-muted-foreground truncate min-w-0 flex-1">
                {msg.snippet}
              </span>
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {mounted ? formatMessageDate(msg.date) : msg.date}
              </span>
            </button>
          );
        }

        return (
          // No overflow-hidden: it would clip the details panel that drops out
          // of the header. The header carries its own rounded-t-xl instead,
          // which is all the clipping was doing (its tinted background is the
          // only thing that reaches the card's corners).
          <div key={msg.id} id={`msg-${msg.id}`} className="scroll-mt-4 bg-card border rounded-xl shadow-sm">
            {/*
              Message Header — clicking it collapses the message back, as in
              Gmail. A div rather than a button now that it contains its own
              interactive control (the details caret): a button nested inside a
              button is invalid HTML and browsers handle it inconsistently.
              role/tabIndex/onKeyDown keep it operable from the keyboard.
            */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(msg.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(msg.id);
                }
              }}
              className="w-full bg-muted/10 border-b rounded-t-xl px-6 py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4 text-left hover:bg-muted/20 transition-colors cursor-pointer"
            >
              <div className="flex items-start gap-3 min-w-0">
                <Avatar className="size-9 border border-border shrink-0">
                  <AvatarFallback className="bg-muted text-muted-foreground text-xs font-mono font-bold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground leading-none">{name}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-1 leading-none">{email}</div>

                  {/*
                    "to me, Smog ▾" — the short summary, with the full
                    from/to/cc/date/subject behind the caret, exactly like
                    Gmail's own header popup.
                  */}
                  <div className="relative mt-1.5">
                    <button
                      type="button"
                      data-message-details-toggle
                      onClick={(e) => {
                        e.stopPropagation(); // don't collapse the message
                        setDetailsFor((current) => (current === msg.id ? null : msg.id));
                      }}
                      title="Show details"
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors max-w-full"
                    >
                      <span className="truncate">
                        to {summariseRecipients(msg.to, selfEmail) || "—"}
                        {msg.cc ? `, cc ${summariseRecipients(msg.cc, selfEmail)}` : ""}
                      </span>
                      <ChevronDownIcon className="size-3 shrink-0" />
                    </button>

                    {detailsFor === msg.id && (
                      <div
                        ref={detailsRef}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute left-0 top-full z-20 mt-1 w-max max-w-[min(32rem,calc(100vw-4rem))] rounded-lg border bg-popover p-3 shadow-lg"
                      >
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                          <dt className="text-muted-foreground text-right">from:</dt>
                          <dd className="break-all">
                            <span className="font-semibold">{name}</span>{" "}
                            <span className="text-muted-foreground">{email}</span>
                          </dd>

                          <dt className="text-muted-foreground text-right">to:</dt>
                          <dd className="break-all">{msg.to || "—"}</dd>

                          {msg.cc && (
                            <>
                              <dt className="text-muted-foreground text-right">cc:</dt>
                              <dd className="break-all">{msg.cc}</dd>
                            </>
                          )}

                          <dt className="text-muted-foreground text-right">date:</dt>
                          <dd>{mounted ? formatMessageDate(msg.date) : msg.date}</dd>

                          <dt className="text-muted-foreground text-right">subject:</dt>
                          <dd className="break-words">{msg.subject}</dd>
                        </dl>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-xs font-mono text-muted-foreground shrink-0">
                {mounted ? formatMessageDate(msg.date) : msg.date}
              </div>
            </div>

            {/* Message Body */}
            <div className="p-6">
              <div className="overflow-x-auto max-w-full">
                <MessageBody msg={msg} />
              </div>
              {/* Inside the body block, so attachments read as part of the
                  message rather than as chrome attached to the thread. One edit
                  covers two surfaces: this list is shared with the assistant's
                  EmailReferenceCard sheet, so those get chips too. */}
              <AttachmentList attachments={msg.attachments} onStored={markAttachmentStored} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
