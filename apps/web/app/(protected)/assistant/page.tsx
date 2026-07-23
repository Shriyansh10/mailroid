"use client";

import React, { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { motion } from "framer-motion";
import { 
  BotIcon, 
  SendIcon, 
  SparklesIcon, 
  MessageSquareIcon, 
  ArrowLeftIcon, 
  Loader2Icon, 
  ShieldAlertIcon, 
  CheckIcon, 
  XIcon,
  Trash2Icon
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useConversations, useConversationMessages, useDeleteConversation } from "@web/hooks/api/assistant";
import { useSession } from "@web/lib/auth-client";
import { DailyUsageWidget } from "@web/components/DailyUsageWidget";
import { Button } from "@web/components/ui/button";
import { Progress } from "@web/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@web/components/ui/tooltip";
import { EmailReferenceCard, type EmailReference } from "@web/components/email-reference-card";
import { cn } from "@web/lib/utils";

interface RenderableItem {
  type: "message" | "tool_call";
  id: string;
  role?: string;
  content?: string;
  msgRef?: ChatMessage;
  toolName?: string;
  toolArgs?: any;
  status?: "running" | "success" | "error";
  resultSummary?: string;
  /** The email under discussion as of this reply — the newest emailRef-bearing tool result at or before this point in the conversation. Renders an EmailReferenceCard beneath assistant replies. */
  emailRef?: EmailReference;
}

interface ChatMessage {
  id: string;
  role: "user" | "ai" | "assistant" | "tool";
  content: string;
  tool_calls?: any;
  tool_call_id?: string;
  /** Set on a tool message when it named a specific email — see apps/web/lib/assistant/tool-memory.ts EmailRef. Drives the EmailReferenceCard under the assistant's reply. */
  metadata?: { emailRef?: EmailReference } | null;
  /** Undefined for normal messages, set when AI needs approval */
  approvalRequired?: {
    approvalId: string;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    preview: string;
    reasoningContent: string | null;
    status?: string;
  };
}

// Backstop for the "never emit a link" prompt rule (system-prompt.ts): the
// prompt tells Dobbie not to write links at all, but this is what holds if
// the model slips or untrusted email content smuggles a URL through. Only a
// relative /inbox/... path is ever rendered as a clickable href; anything
// else keeps its visible text but loses the link entirely.
const markdownComponents = {
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    if (typeof href === "string" && href.startsWith("/inbox/")) {
      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    }
    return <>{children}</>;
  },
};

// The system prompt is now built server-side only — see
// apps/web/lib/assistant/system-prompt.ts and the Context section in
// apps/web/app/api/chat/route.ts for why (the client-built version could be
// overridden by a crafted request, since /api/chat used to trust
// messages[0] verbatim).

// useSearchParams() (needed to read ?conversationId=) requires a Suspense
// boundary around any component that calls it, or the production build fails.
export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <AssistantPageInner />
    </Suspense>
  );
}

function AssistantPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [isMounted, setIsMounted] = useState(false);
  const [isNewChat, setIsNewChat] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Reported by /api/chat after each turn — how much of the model's context
  // window this conversation is now using. Cleared whenever the active
  // conversation changes, so a stale reading from a different chat never
  // lingers on screen.
  const [contextUsage, setContextUsage] = useState<{
    usedTokens: number;
    maxTokens: number;
    percentUsed: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Which ?conversationId= has already been consumed, so re-navigating to
  // the SAME /assistant route with a different id (a soft nav, no remount)
  // still opens it rather than silently doing nothing.
  const consumedDiscussIdRef = useRef<string | null>(null);

  // Persistence State & Hooks
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const { conversations, refetch: refetchConversations } = useConversations();
  const { messages: dbMessages, isLoading: isLoadingMessages, refetch: refetchMessages } = useConversationMessages(currentConversationId);
  const { deleteConversationAsync } = useDeleteConversation();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const getGreeting = () => {
    const hr = new Date().getHours();
    if (hr < 12) return "Good morning";
    if (hr < 17) return "Good afternoon";
    return "Good evening";
  };

  const getToolRunningText = (name: string): string => {
    if (name === "searchEmails") return "Searching your mailbox...";
    if (name === "getEvents") return "Retrieving calendar events...";
    if (name === "sendEmail") return "Sending email...";
    if (name === "createEvent") return "Creating calendar event...";
    if (name === "generateExecutiveBrief") return "Generating executive briefing...";
    if (name === "summarizeEmail") return "Reading and summarizing email...";
    if (name === "getEmailDetail") return "Looking up that detail...";
    if (name === "replyToEmail") return "Sending reply...";
    if (name === "forwardEmail") return "Forwarding email...";
    return `Executing tool ${name}...`;
  };

  const getToolSuccessText = (name: string): string => {
    if (name === "searchEmails") return "✓ Searched your mailbox";
    if (name === "getEvents") return "✓ Calendar events retrieved";
    if (name === "sendEmail") return "✓ Email sent successfully";
    if (name === "createEvent") return "✓ Event created successfully";
    if (name === "generateExecutiveBrief") return "✓ Executive briefing generated";
    if (name === "summarizeEmail") return "✓ Email summarized";
    if (name === "getEmailDetail") return "✓ Found the detail";
    if (name === "replyToEmail") return "✓ Reply sent";
    if (name === "forwardEmail") return "✓ Email forwarded";
    return `✓ Executed tool ${name}`;
  };

  // Group conversations by date (Today, Yesterday, Older)
  const groupedConversations = useMemo(() => {
    if (!conversations) return { today: [], yesterday: [], older: [] };
    const today: typeof conversations = [];
    const yesterday: typeof conversations = [];
    const older: typeof conversations = [];

    const todayDate = new Date();
    todayDate.setHours(0,0,0,0);

    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    yesterdayDate.setHours(0,0,0,0);

    conversations.forEach((conv) => {
      if (!conv.updatedAt && !conv.createdAt) {
        older.push(conv);
        return;
      }
      const dateVal = conv.updatedAt || conv.createdAt;
      const convDate = new Date(dateVal);
      convDate.setHours(0,0,0,0);

      if (convDate.getTime() === todayDate.getTime()) {
        today.push(conv);
      } else if (convDate.getTime() === yesterdayDate.getTime()) {
        yesterday.push(conv);
      } else {
        older.push(conv);
      }
    });

    return { today, yesterday, older };
  }, [conversations]);

  // Construct structured stream items including message blocks and tool status cards
  const renderableItems = useMemo(() => {
    const items: RenderableItem[] = [];
    
    // Create a map to find the result of each tool call by id
    const toolResponses = new Map<string, ChatMessage>();
    messages.forEach((msg) => {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResponses.set(msg.tool_call_id, msg);
      }
    });

    // Tracks the email under discussion as we walk the transcript in order —
    // the newest emailRef-bearing tool result at or before each point —
    // mirroring the server's "active email" semantics (apps/web/lib/assistant/history.ts).
    // Attached to EVERY assistant reply while that email is active, not just
    // the first one: this is the only way to open/reply to/forward the
    // email, so it needs to still be there on, say, the reply to "can I
    // open it?" — which is exactly the turn a "show once" rule would hide it on.
    let currentEmailRef: EmailReference | undefined;

    messages.forEach((msg) => {
      if (msg.role === "user") {
        items.push({
          type: "message",
          id: msg.id,
          role: "user",
          content: msg.content,
          msgRef: msg,
        });
      } else if (msg.role === "tool") {
        const ref = msg.metadata?.emailRef;
        if (ref) currentEmailRef = ref;
      } else if (msg.role === "assistant" || msg.role === "ai") {
        // If the message contains text content or pending approvals, add a message block
        if (msg.content || msg.approvalRequired) {
          items.push({
            type: "message",
            id: msg.id,
            role: "assistant",
            content: msg.content,
            msgRef: msg,
            emailRef: currentEmailRef,
          });
        }

        // If it includes tool calls, add a tool call status card for each call
        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls.forEach((tc: any) => {
            const response = toolResponses.get(tc.id);
            
            let status: "running" | "success" | "error" = "running";
            let resultSummary = "";
            
            if (response) {
              status = "success";
              const responseText = response.content || "";
              const toolName = tc.function?.name || "";
              
              if (toolName === "searchEmails") {
                try {
                  const parsed = JSON.parse(responseText);
                  const count = parsed.emails?.length ?? 0;
                  resultSummary = `Found ${count} matching ${count === 1 ? "email" : "emails"}`;
                } catch {
                  resultSummary = "Searched Gmail";
                }
              } else if (toolName === "getEvents") {
                try {
                  const parsed = JSON.parse(responseText);
                  const count = parsed.events?.length ?? 0;
                  resultSummary = `Found ${count} matching calendar ${count === 1 ? "event" : "events"}`;
                } catch {
                  resultSummary = "Retrieved calendar events";
                }
              } else if (toolName === "sendEmail") {
                resultSummary = "Email sent successfully";
              } else if (toolName === "createEvent") {
                resultSummary = "Event created successfully";
              } else if (toolName === "generateExecutiveBrief") {
                resultSummary = "Executive briefing generated";
              } else if (toolName === "summarizeEmail") {
                try {
                  const parsed = JSON.parse(responseText);
                  resultSummary = parsed.found
                    ? `Summarized "${parsed.subject ?? "email"}"`
                    : "No matching email found";
                } catch {
                  resultSummary = "Email summarized";
                }
              } else if (toolName === "getEmailDetail") {
                resultSummary = "Found the relevant passage";
              } else if (toolName === "replyToEmail") {
                resultSummary = "Reply sent";
              } else if (toolName === "forwardEmail") {
                resultSummary = "Email forwarded";
              } else {
                resultSummary = "Completed successfully";
              }
            } else {
              status = "running";
            }
            
            items.push({
              type: "tool_call",
              id: tc.id || Math.random().toString(),
              toolName: tc.function?.name || "tool",
              toolArgs: (() => {
                try {
                  return tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                } catch {
                  return {};
                }
              })(),
              status,
              resultSummary,
            });
          });
        }
      }
    });
    
    return items;
  }, [messages]);

  // Sync database messages to local React state
  useEffect(() => {
    if (dbMessages) {
      const mapped = dbMessages.map((msg) => {
        let mappedRole: "user" | "ai" | "assistant" | "tool" = "user";
        if (msg.role === "user") mappedRole = "user";
        else if (msg.role === "assistant") mappedRole = "assistant";
        else if (msg.role === "tool") mappedRole = "tool";

        return {
          id: msg.id,
          role: mappedRole,
          content: msg.content || "",
          tool_calls: msg.toolCalls || undefined,
          tool_call_id: msg.toolCallId || undefined,
          metadata: msg.metadata as { emailRef?: EmailReference } | null | undefined,
          approvalRequired: msg.approvalRequired ? {
            approvalId: msg.approvalRequired.approvalId,
            toolName: msg.approvalRequired.toolName,
            toolCallId: msg.approvalRequired.toolCallId,
            args: msg.approvalRequired.args as Record<string, unknown>,
            preview: msg.approvalRequired.preview,
            reasoningContent: msg.approvalRequired.reasoningContent,
            status: msg.approvalRequired.status,
          } : undefined,
        };
      });
      setMessages(mapped);
    }
  }, [dbMessages]);

  // The server now owns conversation history and the system prompt (see
  // apps/web/app/api/chat/route.ts) — this only ever sends the ONE new user
  // message plus which conversation it belongs to. The client's optimistic
  // `messages` state is just for immediate rendering; refetchMessages()
  // below reconciles it against the database right after.
  const handleSend = async (text: string) => {
    if (isLoading) return;
    if (!text.trim()) return;

    const newMessages: ChatMessage[] = [
      ...messages,
      { id: Date.now().toString(), role: "user", content: text },
    ];

    if (isNewChat) {
      setIsNewChat(false);
    }

    setMessages(newMessages);
    setPrompt("");
    setIsLoading(true);

    const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    try {
      abortRef.current = new AbortController();

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-timezone": userTimeZone,
        },
        body: JSON.stringify({
          message: text,
          conversationId: currentConversationId,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Server error (${res.status})`);
      }

      const data = await res.json();
      window.dispatchEvent(new Event("assistant-action-completed"));

      if (data.contextUsage) {
        setContextUsage(data.contextUsage);
      }

      if (data.conversationId && data.conversationId !== currentConversationId) {
        setCurrentConversationId(data.conversationId);
      } else {
        refetchMessages();
      }

      refetchConversations();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: error instanceof Error ? `Error: ${error.message}` : "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  // "Discuss with Dobbie" hand-off. EmailSummaryCard's handleDiscuss calls
  // POST /api/chat/seed itself (which builds and PERSISTS the "assistant
  // called summarizeEmail" round-trip server-side — see that route) and
  // navigates here with ?conversationId={id}. This effect just opens that
  // conversation like any other one in the sidebar; there is no synthetic
  // client-side history to construct or trust.
  //
  // Deps are keyed on the ?conversationId value (not just mount): pushing to
  // /assistant a second time from a different email is a same-pathname
  // navigation, which Next.js may serve by reusing this component instance
  // rather than remounting it, so a mount-only effect would silently miss it.
  useEffect(() => {
    const seededConversationId = searchParams.get("conversationId");
    if (!seededConversationId || consumedDiscussIdRef.current === seededConversationId) return;

    consumedDiscussIdRef.current = seededConversationId;
    // Strip the query param regardless of outcome — a dead link must not
    // sit in the address bar.
    router.replace("/assistant", { scroll: false });

    // Inlined rather than calling handleOpenOldChat (declared further below
    // in this component) to avoid a same-scope forward reference.
    setIsNewChat(false);
    setPrompt("");
    setContextUsage(null);
    setCurrentConversationId(seededConversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleOpenOldChat = (conversationId: string) => {
    setIsNewChat(false);
    setPrompt("");
    setContextUsage(null);
    setCurrentConversationId(conversationId);
  };

  const handleNewChat = () => {
    setIsNewChat(true);
    setMessages([]);
    setContextUsage(null);
    setCurrentConversationId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSend(prompt);
    }
  };

  const handleApprove = async (msg: ChatMessage) => {
    const ar = msg.approvalRequired;
    if (!ar) return;

    setIsLoading(true);

    // /api/approvals/approve rebuilds history and the system prompt
    // server-side (same helpers /api/chat uses) — this only needs to name
    // which approval to resume and pass along reasoningContent, which is
    // ephemeral client-held state (DeepSeek's reasoning_content from the
    // turn that requested the tool call) not persisted anywhere server-side.
    try {
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/approvals/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-timezone": userTimeZone,
        },
        body: JSON.stringify({
          approvalId: ar.approvalId,
          reasoningContent: ar.reasoningContent,
          conversationId: currentConversationId,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Server error (${res.status})`);
      }

      const data = await res.json();
      window.dispatchEvent(new Event("assistant-action-completed"));

      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                approvalRequired: m.approvalRequired
                  ? { ...m.approvalRequired, status: "EXECUTED" }
                  : undefined,
              }
            : m,
        );
        if (data.newMessages && Array.isArray(data.newMessages)) {
          const mappedNew = data.newMessages.map((m: any) => ({
            id: m.id || Math.random().toString(),
            role: m.role,
            content: m.content || "",
            tool_calls: m.toolCalls || undefined,
            tool_call_id: m.toolCallId || undefined,
          }));
          return [...updated, ...mappedNew];
        } else {
          return updated.concat({
            id: `approved-${Date.now()}`,
            role: "assistant",
            content: data.content ?? "Action completed.",
          });
        }
      });

      await refetchMessages();
      refetchConversations();
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, content: `${m.content}\n\n❌ ${error instanceof Error ? error.message : "Approval failed"}` }
            : m,
        ),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async (msg: ChatMessage) => {
    const ar = msg.approvalRequired;
    if (!ar) return;

    setIsLoading(true);

    try {
      const res = await fetch("/api/approvals/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: ar.approvalId }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Server error (${res.status})`);
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                approvalRequired: m.approvalRequired
                  ? { ...m.approvalRequired, status: "CANCELLED" }
                  : undefined,
              }
            : m,
        ),
      );

      await refetchMessages();
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, content: `${m.content}\n\n❌ ${error instanceof Error ? error.message : "Cancel failed"}` }
            : m,
        ),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteChat = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this conversation?")) {
      try {
        await deleteConversationAsync({ conversationId: convId });
        if (currentConversationId === convId) {
          handleNewChat();
        }
        refetchConversations();
      } catch (err) {
        console.error("Delete conversation failed", err);
      }
    }
  };

  const renderConvItem = (conv: any) => (
    <li key={conv.id} className="group relative flex items-center w-full">
      <button 
        onClick={() => handleOpenOldChat(conv.id)}
        className={`w-full flex items-center gap-3 p-2.5 rounded-lg transition-colors text-sm text-left truncate pr-8 ${
          currentConversationId === conv.id 
            ? "bg-[#b08d57]/15 text-[#b08d57] font-semibold" 
            : "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
        }`}
      >
        <MessageSquareIcon className="size-4 shrink-0" />
        <div className="flex flex-col truncate w-full">
          <span className="truncate">{conv.title}</span>
          {conv.lastMessagePreview && (
            <span className="truncate text-[10px] text-muted-foreground font-normal mt-0.5">
              {conv.lastMessagePreview}
            </span>
          )}
        </div>
      </button>
      <button
        onClick={(e) => handleDeleteChat(conv.id, e)}
        className="absolute right-2 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-accent/70 transition-all p-1 rounded-md text-muted-foreground"
        title="Delete Conversation"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </li>
  );

  if (!isMounted) return null;

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans">
      
      {/* Sidebar - classic chatgpt style */}
      <div className="w-[260px] bg-muted/10 border-r border-border flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <Button 
            onClick={handleNewChat}
            variant="outline"
            className="w-full flex items-center justify-start gap-2.5 h-10 font-mono text-xs uppercase border-border/80"
          >
            <SparklesIcon className="size-3.5 text-[#b08d57]" />
            New Chat
          </Button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {groupedConversations.today.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-[10px] font-mono font-bold tracking-widest text-[#b08d57] uppercase px-3 mb-2">Today</h3>
              <ul className="space-y-0.5">
                {groupedConversations.today.map((conv: any) => renderConvItem(conv))}
              </ul>
            </div>
          )}
          {groupedConversations.yesterday.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground uppercase px-3 mb-2">Yesterday</h3>
              <ul className="space-y-0.5">
                {groupedConversations.yesterday.map((conv: any) => renderConvItem(conv))}
              </ul>
            </div>
          )}
          {groupedConversations.older.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/60 uppercase px-3 mb-2">Previous</h3>
              <ul className="space-y-0.5">
                {groupedConversations.older.map((conv: any) => renderConvItem(conv))}
              </ul>
            </div>
          )}
          {conversations && conversations.length === 0 && (
            <div className="text-xs text-muted-foreground px-3 py-2 italic">No conversations yet</div>
          )}
        </div>

        <div className="p-4 border-t border-border flex flex-col gap-3">
          <DailyUsageWidget />
          <Button 
            onClick={() => router.push("/inbox")} 
            variant="ghost" 
            className="w-full justify-start gap-2.5 h-10 text-muted-foreground hover:text-foreground font-mono text-xs uppercase"
          >
             <ArrowLeftIcon className="size-3.5" />
             Back to Inbox
          </Button>
          <div className="flex items-center gap-2.5 px-3 py-1 text-sm font-serif font-bold text-foreground select-none">
            <BotIcon className="size-4.5 text-[#b08d57]" />
            <span>Dobbie Assistant</span>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative h-full items-center bg-background">
        
        {/* Minimal Header */}
        <div className="w-full border-b bg-background/80 backdrop-blur px-8 py-4 flex items-center justify-between z-10 shrink-0 select-none">
          <div className="flex flex-col">
            <span className="flex items-center gap-2 font-serif text-base font-bold text-foreground">
              ✨ Dobbie
            </span>
            <span className="text-[10px] font-mono uppercase tracking-widest text-[#b08d57] font-bold">
              AI Executive Assistant
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleNewChat}
              className="font-mono text-[10px] uppercase h-8"
            >
              New Chat
            </Button>
          </div>
        </div>

        {/* Loading Indicator */}
        {isLoadingMessages && !isNewChat ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2Icon className="size-8 animate-spin text-[#b08d57]" />
          </div>
        ) : (
          /* Messages and Tool calls list */
          !isNewChat && (
            <div className="w-full flex-1 overflow-y-auto p-4 space-y-6 pb-40">
              {renderableItems.map((item: any) => {
                if (item.type === "message") {
                  const msg = item.msgRef!;
                  return (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={msg.id} 
                      className={`w-full max-w-3xl mx-auto flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {msg.role !== 'user' && (
                        <div className="size-8 rounded-full bg-[#b08d57]/10 text-[#b08d57] flex items-center justify-center shrink-0 mt-1 select-none border border-[#b08d57]/20">
                          <BotIcon className="size-4.5" />
                        </div>
                      )}
                      <div className={`${
                        msg.role === 'user' 
                          ? 'bg-primary text-primary-foreground rounded-2xl px-4 py-2.5 max-w-[80%] text-[13px] font-sans font-medium shadow-sm' 
                          : 'bg-muted/40 border border-border/50 rounded-2xl px-5 py-4 w-full text-foreground text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none'
                      }`}>
                        {msg.role === 'user' ? (
                          msg.content
                        ) : (
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {msg.content}
                          </ReactMarkdown>
                        )}
                        {msg.approvalRequired && (() => {
                          const status = msg.approvalRequired.status || "PENDING";
                          if (status === "EXECUTED" || status === "APPROVED") {
                            return (
                              <div className="mt-3 border border-emerald-500/20 bg-emerald-500/5 rounded-xl p-4 max-w-md flex items-start gap-3 text-emerald-800 dark:text-emerald-300">
                                <div className="size-5 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0 mt-0.5 border border-emerald-500/20">
                                  <CheckIcon className="size-3" />
                                </div>
                                <div>
                                  <div className="font-serif font-bold text-xs text-emerald-700 dark:text-emerald-400">Action Approved & Executed</div>
                                  <p className="text-[9px] text-emerald-500 font-mono uppercase tracking-widest mt-0.5">{msg.approvalRequired.toolName}</p>
                                  <p className="text-xs text-muted-foreground mt-2">{msg.approvalRequired.preview}</p>
                                </div>
                              </div>
                            );
                          }
                          if (status === "CANCELLED" || status === "REJECTED") {
                            return (
                              <div className="mt-3 border border-border bg-muted/30 rounded-xl p-4 max-w-md flex items-start gap-3 text-muted-foreground">
                                <div className="size-5 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0 mt-0.5 border">
                                  <XIcon className="size-3" />
                                </div>
                                <div>
                                  <div className="font-serif font-bold text-xs text-foreground/80">Action Rejected</div>
                                  <p className="text-[9px] text-muted-foreground font-mono uppercase tracking-widest mt-0.5">{msg.approvalRequired.toolName}</p>
                                  <p className="text-xs text-muted-foreground/60 mt-2">{msg.approvalRequired.preview}</p>
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div className="mt-4 border border-[#b08d57]/30 bg-[#b08d57]/5 rounded-xl p-5 max-w-md shadow-sm">
                              <div className="flex items-center gap-2 text-[#b08d57] font-serif font-bold text-sm mb-3">
                                <ShieldAlertIcon className="size-4 animate-pulse" />
                                Approval Required
                              </div>
                              
                              <div className="bg-background/60 border border-border/40 rounded-lg p-3.5 mb-4 text-xs space-y-2">
                                <div className="flex items-center justify-between border-b pb-1.5">
                                  <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                                    Action type
                                  </span>
                                  <span className="font-mono font-bold text-foreground">
                                    {msg.approvalRequired.toolName}
                                  </span>
                                </div>
                                
                                {msg.approvalRequired.args && (() => {
                                  const args = msg.approvalRequired.args;
                                  return (
                                    <div className="space-y-1.5 pt-1 text-foreground/80 leading-relaxed font-sans">
                                      {args.to && (
                                        <div>
                                          <span className="font-medium text-muted-foreground">To:</span> {String(args.to)}
                                        </div>
                                      )}
                                      {args.subject && (
                                        <div>
                                          <span className="font-medium text-muted-foreground">Subject:</span> {String(args.subject)}
                                        </div>
                                      )}
                                      {args.title && (
                                        <div>
                                          <span className="font-medium text-muted-foreground">Title:</span> {String(args.title)}
                                        </div>
                                      )}
                                      {args.start && (
                                        <div>
                                          <span className="font-medium text-muted-foreground">Start:</span> {new Date(String(args.start)).toLocaleString()}
                                        </div>
                                      )}
                                      {args.end && (
                                        <div>
                                          <span className="font-medium text-muted-foreground">End:</span> {new Date(String(args.end)).toLocaleString()}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}

                                {!msg.approvalRequired.args?.subject && !msg.approvalRequired.args?.title && (
                                  <p className="text-sm text-foreground pt-1">{msg.approvalRequired.preview}</p>
                                )}
                              </div>

                              <div className="flex gap-2">
                                <Button
                                  onClick={() => handleApprove(msg)}
                                  disabled={isLoading}
                                  className="flex items-center gap-1.5 bg-[#b08d57] text-white text-xs font-semibold rounded-lg hover:bg-[#8c6f37] disabled:opacity-50 transition-colors h-8 px-3.5 font-mono uppercase tracking-wider shadow-sm"
                                >
                                  <CheckIcon className="size-3.5" />
                                  Approve
                                </Button>
                                <Button
                                  variant="outline"
                                  onClick={() => handleCancel(msg)}
                                  disabled={isLoading}
                                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-xs font-semibold rounded-lg border hover:bg-accent disabled:opacity-50 transition-colors h-8 px-3.5 font-mono uppercase tracking-wider"
                                >
                                  <XIcon className="size-3.5" />
                                  Reject
                                </Button>
                              </div>
                            </div>
                          );
                        })()}
                        {item.emailRef && <EmailReferenceCard emailRef={item.emailRef} />}
                      </div>
                    </motion.div>
                  );
                } else if (item.type === "tool_call") {
                  return (
                    <motion.div 
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={item.id}
                      className="w-full max-w-3xl mx-auto flex gap-4 justify-start"
                    >
                      <div className="size-8 rounded-full bg-[#b08d57]/10 text-[#b08d57] flex items-center justify-center shrink-0 mt-1 select-none border border-[#b08d57]/20">
                        <BotIcon className="size-4.5" />
                      </div>
                      <div className="bg-muted/40 border border-border/50 rounded-xl p-3.5 text-xs font-mono text-muted-foreground flex items-center gap-2.5 w-full max-w-md shadow-sm">
                        {item.status === "running" ? (
                          <>
                            <Loader2Icon className="size-3.5 animate-spin text-[#b08d57]" />
                            <span>{getToolRunningText(item.toolName || "")}</span>
                          </>
                        ) : item.status === "success" ? (
                          <>
                            <CheckIcon className="size-3.5 text-emerald-600" />
                            <span className="text-foreground">{item.resultSummary || getToolSuccessText(item.toolName || "")}</span>
                          </>
                        ) : (
                          <>
                            <XIcon className="size-3.5 text-red-600" />
                            <span className="text-red-500">Failed to execute tool</span>
                          </>
                        )}
                      </div>
                    </motion.div>
                  );
                }
                return null;
              })}
              {isLoading && (
                <div className="w-full max-w-3xl mx-auto flex gap-4 justify-start">
                  <div className="size-8 rounded-full bg-[#b08d57]/10 text-[#b08d57] flex items-center justify-center shrink-0 mt-1 select-none border border-[#b08d57]/20">
                    <BotIcon className="size-4.5" />
                  </div>
                  <div className="bg-muted/30 border border-border/40 rounded-2xl px-5 py-4 w-full max-w-md flex items-center gap-3 text-sm text-muted-foreground select-none shadow-sm">
                    <Loader2Icon className="size-4 animate-spin text-[#b08d57]" />
                    <span className="font-serif">Dobbie is working...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef as any} />
            </div>
          )
        )}

        {/* Prompt Input Container */}
        <motion.div 
          layout
          className={`absolute w-full max-w-3xl px-4 z-20 ${
            isNewChat 
              ? "top-1/2 -translate-y-1/2 flex flex-col" 
              : "bottom-8"
          }`}
        >
          {isNewChat && (
            <motion.div 
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-8 text-center max-w-lg mx-auto"
            >
              <h1 className="text-3xl font-serif font-bold text-foreground mb-3 tracking-tight">
                {getGreeting()}, {session?.user?.name ? session.user.name.split(" ")[0] : "there"}.
              </h1>
              <p className="text-sm text-muted-foreground">
                What would you like to do today?
              </p>
            </motion.div>
          )}

          <motion.div 
            layoutId="prompt-bar"
            className="w-full relative shadow-sm rounded-2xl bg-background border border-border/60 flex flex-col px-4 py-3"
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Dobbie anything..."
              disabled={isLoading}
              className="w-full bg-transparent border-none outline-none resize-none text-[14px] text-foreground placeholder:text-muted-foreground/60 py-2 px-1"
            />
            <div className="flex items-center justify-between mt-1">
              {contextUsage ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 cursor-default">
                      <Progress
                        value={contextUsage.percentUsed}
                        className={cn(
                          "h-1.5 w-16",
                          contextUsage.percentUsed >= 85 && "[&>div]:bg-red-500",
                          contextUsage.percentUsed >= 60 && contextUsage.percentUsed < 85 && "[&>div]:bg-amber-500",
                        )}
                      />
                      <span className="text-[9px] font-mono text-muted-foreground tabular-nums">
                        {contextUsage.percentUsed}%
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-55 text-center text-xs">
                    This chat has used about {contextUsage.percentUsed}% of the context window Dobbie can remember.
                    {contextUsage.percentUsed >= 60
                      ? " It's getting full — start a new chat soon so nothing from this one gets pushed out."
                      : " Plenty of room left for now."}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span />
              )}
              <button
                onClick={() => handleSend(prompt)}
                disabled={!prompt.trim() || isLoading}
                className={`size-8 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
                  prompt.trim() && !isLoading 
                    ? "bg-[#b08d57] text-white hover:bg-[#8c6f37]" 
                    : "bg-muted text-muted-foreground cursor-not-allowed"
                }`}
              >
                {isLoading ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SendIcon className="size-3.5 ml-0.5" />
                )}
              </button>
            </div>
          </motion.div>

          {/* Cards below the input ONLY in new chat */}
          {isNewChat && (
             <motion.div 
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               transition={{ delay: 0.2 }}
               className="mt-8 flex flex-wrap justify-center gap-2.5 max-w-2xl mx-auto"
             >
               <Button
                 variant="outline"
                 onClick={() => handleSend("Prepare me for today")}
                 className="text-xs font-mono uppercase border border-[#b08d57]/40 bg-[#b08d57]/5 text-[#b08d57] hover:bg-[#b08d57]/10 rounded-xl h-9 px-4 shrink-0 transition-colors"
               >
                 Prepare me for today
               </Button>
               <Button
                 variant="outline"
                 onClick={() => handleSend("Summarize my unread emails")}
                 className="text-xs font-mono uppercase border border-border/80 bg-background text-foreground hover:bg-accent/50 rounded-xl h-9 px-4 shrink-0 transition-colors"
               >
                 Summarize unread emails
               </Button>
               <Button 
                 variant="outline" 
                 onClick={() => handleSend("Schedule a meeting next week")}
                 className="text-xs font-mono uppercase border border-border/80 bg-background text-foreground hover:bg-accent/50 rounded-xl h-9 px-4 shrink-0 transition-colors"
               >
                 Schedule a meeting next week
               </Button>
               <Button 
                 variant="outline" 
                 onClick={() => handleSend("Find emails from investors")}
                 className="text-xs font-mono uppercase border border-border/80 bg-background text-foreground hover:bg-accent/50 rounded-xl h-9 px-4 shrink-0 transition-colors"
               >
                 Find emails from investors
               </Button>
               <Button 
                 variant="outline" 
                 onClick={() => handleSend("Draft a follow-up email")}
                 className="text-xs font-mono uppercase border border-border/80 bg-background text-foreground hover:bg-accent/50 rounded-xl h-9 px-4 shrink-0 transition-colors"
               >
                 Draft a follow-up email
               </Button>
             </motion.div>
          )}

        </motion.div>

      </div>
    </div>
  );
}
