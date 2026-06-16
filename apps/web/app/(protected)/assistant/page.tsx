"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { BotIcon, SendIcon, SparklesIcon, MessageSquareIcon, ArrowLeftIcon, Loader2Icon, ShieldAlertIcon, CheckIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";

const OLD_CHATS = [
  "Schedule meeting with the marketing team",
  "Summarize my unread important emails",
  "Reply to investors regarding Q3 report",
  "Find files related to project Alpha",
];

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  content: string;
  /** Undefined for normal messages, set when AI needs approval */
  approvalRequired?: {
    approvalId: string;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    preview: string;
    reasoningContent: string | null;
  };
}

export default function AssistantPage() {
  const router = useRouter();
  const [isMounted, setIsMounted] = useState(false);
  const [isNewChat, setIsNewChat] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: ChatMessage = { id: Date.now().toString(), role: "user", content: text };

    if (isNewChat) {
      setIsNewChat(false);
    }

    setMessages((prev) => [...prev, userMessage]);
    setPrompt("");
    setIsLoading(true);

    // Build conversation history for the API
    const now = new Date();
    const systemPrompt = [
      `You are Dobbie, a helpful executive assistant. Be concise and professional.`,
      `You help with emails, calendar, and productivity tasks.`,
      ``,
      `Current date and time: ${now.toISOString()}`,
      `User's local time: ${now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}`,
      `Timezone offset: UTC${now.getTimezoneOffset() <= 0 ? "+" : "-"}${String(Math.abs(Math.floor(now.getTimezoneOffset() / 60))).padStart(2, "0")}:${String(Math.abs(now.getTimezoneOffset() % 60)).padStart(2, "0")}`,
      ``,
      `When creating calendar events, always use ISO 8601 datetime format with the correct year.`,
      `"Day after tomorrow" means ${new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)}.`,
      `"Tomorrow" means ${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}.`,
      ``,
      `After successfully executing a tool, summarize what you did clearly and concisely.`,
      `If a tool fails, explain the error to the user in plain language.`,
    ].join("\n");

    const apiMessages = [
      { role: "system" as const, content: systemPrompt },
      ...messages.map((m) => ({ role: m.role === "ai" ? ("assistant" as const) : ("user" as const), content: m.content })),
      { role: "user" as const, content: text },
    ];

    try {
      abortRef.current = new AbortController();

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Server error (${res.status})`);
      }

      const data = await res.json();

      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "ai",
        content: data.content ?? "(no response)",
      };

      // Attach approval info if present
      if (data.approvalRequired) {
        aiMessage.approvalRequired = data.approvalRequired;
      }

      setMessages((prev) => [...prev, aiMessage]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "ai",
          content: error instanceof Error ? `Error: ${error.message}` : "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  const handleOpenOldChat = (chatTitle: string) => {
    setIsNewChat(false);
    setPrompt("");

    setMessages([
      { id: `old-user-${Date.now()}`, role: "user", content: chatTitle },
      { id: `old-ai-${Date.now()}`, role: "ai", content: `Here is the past conversation regarding "${chatTitle}". Let me know if you need any follow-up on this topic!` },
    ]);
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

    // Build conversation history (same as handleSend)
    const apiMessages = [
      {
        role: "system" as const,
        content:
          "You are Dobbie, a helpful executive assistant. Be concise and professional. You help with emails, calendar, and productivity tasks.",
      },
      ...messages
        .filter((m) => !m.approvalRequired) // exclude approval cards
        .map((m) => ({
          role: m.role === "ai" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        })),
    ];

    try {
      const res = await fetch("/api/approvals/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: ar.approvalId,
          messages: apiMessages,
          reasoningContent: ar.reasoningContent,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Server error (${res.status})`);
      }

      const data = await res.json();

      // Remove approval from the message and add AI response
      setMessages((prev) =>
        prev
          .map((m) =>
            m.id === msg.id
              ? { ...m, approvalRequired: undefined, content: `${m.content}\n\n✅ Approved` }
              : m,
          )
          .concat({
            id: `approved-${Date.now()}`,
            role: "ai",
            content: data.content ?? "Action completed.",
          }),
      );
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
            ? { ...m, approvalRequired: undefined, content: `${m.content}\n\n🚫 Cancelled` }
            : m,
        ),
      );
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

  if (!isMounted) return null;

  return (
    <div className="flex h-screen w-full bg-[#FAFAFA] text-slate-900 overflow-hidden font-sans">
      
      {/* Sidebar - classic chatgpt style */}
      <div className="w-[260px] bg-[#202123] text-slate-300 flex flex-col shrink-0">
        <div className="p-3">
          <button 
            onClick={() => { setIsNewChat(true); setMessages([]); }}
            className="w-full flex items-center gap-3 p-3 rounded-md hover:bg-[#2A2B32] transition-colors text-sm font-medium border border-[#4D4D4F]"
          >
            <SparklesIcon className="size-4" />
            New Chat
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          <div>
            <h3 className="text-xs font-semibold text-[#8E8EA0] mb-3 px-3">Recent</h3>
            <ul className="space-y-1">
              {OLD_CHATS.map((chat, idx) => (
                <li key={idx}>
                  <button 
                    onClick={() => handleOpenOldChat(chat)}
                    className="w-full flex items-center gap-3 p-3 rounded-md hover:bg-[#2A2B32] transition-colors text-sm text-left truncate"
                  >
                    <MessageSquareIcon className="size-4 shrink-0" />
                    <span className="truncate">{chat}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="p-4 border-t border-[#4D4D4F] flex flex-col gap-4">
          <button onClick={() => router.push("/inbox")} className="flex items-center gap-3 text-sm hover:bg-[#2A2B32] p-2 rounded-md transition-colors">
             <ArrowLeftIcon className="size-4" />
             Back to Inbox
          </button>
          <div className="flex items-center gap-3 text-sm text-white font-medium px-2">
            <BotIcon className="size-5" />
            <span>Dobbie AI</span>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative h-full items-center">
        
        {/* Messages List */}
        {!isNewChat && (
          <div className="w-full flex-1 overflow-y-auto p-4 space-y-6 pb-40">
            {messages.map((msg) => (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={msg.id} 
                className={`w-full max-w-3xl mx-auto flex gap-6 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'ai' && (
                  <div className="size-8 rounded-sm bg-[#10A37F] text-white flex items-center justify-center shrink-0 mt-1">
                    <BotIcon className="size-5" />
                  </div>
                )}
                <div className={`text-[15px] leading-relaxed ${
                  msg.role === 'user' 
                    ? 'bg-slate-100 px-5 py-3 rounded-3xl max-w-[80%]' 
                    : 'py-1 text-slate-800'
                }`}>
                  {msg.content}
                  {msg.approvalRequired && (
                    <div className="mt-3 border border-amber-200 bg-amber-50 rounded-xl p-4 max-w-sm">
                      <div className="flex items-center gap-2 text-amber-700 font-semibold text-sm mb-2">
                        <ShieldAlertIcon className="size-4" />
                        Approval Required
                      </div>
                      <p className="text-xs text-amber-600 mb-1 font-mono">
                        {msg.approvalRequired.toolName}
                      </p>
                      <p className="text-sm text-slate-700 mb-3">
                        {msg.approvalRequired.preview}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApprove(msg)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                          <CheckIcon className="size-3.5" />
                          Approve
                        </button>
                        <button
                          onClick={() => handleCancel(msg)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-slate-600 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-100 disabled:opacity-50 transition-colors"
                        >
                          <XIcon className="size-3.5" />
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Prompt Input Container */}
        <motion.div 
          layout
          className={`absolute w-full max-w-3xl px-4 ${
            isNewChat 
              ? "top-1/2 -translate-y-1/2 flex flex-col" 
              : "bottom-8"
          }`}
        >
          {isNewChat && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-8 text-center"
            >
              <div className="size-16 bg-[#10A37F] text-white rounded-full flex items-center justify-center mx-auto mb-6 shadow-md">
                <BotIcon className="size-8" />
              </div>
              <h1 className="text-3xl font-semibold text-slate-800 mb-2">How can I help you today?</h1>
            </motion.div>
          )}

          <motion.div 
            layoutId="prompt-bar"
            className="w-full relative shadow-[0_0_15px_rgba(0,0,0,0.1)] rounded-2xl bg-white border border-slate-200 flex flex-col px-4 py-3"
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Dobbie..."
              disabled={isLoading}
              className="w-full bg-transparent border-none outline-none resize-none text-[15px] text-slate-900 placeholder:text-slate-500 py-2 px-1"
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={() => handleSend(prompt)}
                disabled={!prompt.trim() || isLoading}
                className={`size-8 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
                  prompt.trim() && !isLoading ? "bg-black text-white hover:bg-slate-800" : "bg-slate-200 text-slate-400 cursor-not-allowed"
                }`}
              >
                {isLoading ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SendIcon className="size-4 ml-0.5" />
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
               className="mt-8 grid grid-cols-2 gap-3"
             >
               {OLD_CHATS.map((chat, idx) => (
                 <button 
                   key={idx} 
                   onClick={() => handleOpenOldChat(chat)}
                   className="text-left p-4 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors text-sm text-slate-600 font-medium"
                 >
                   {chat}
                 </button>
               ))}
             </motion.div>
          )}

        </motion.div>

      </div>
    </div>
  );
}
