"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { BotIcon, SendIcon, SparklesIcon, MessageSquareIcon, ArrowLeftIcon } from "lucide-react";
import { useRouter } from "next/navigation";

const OLD_CHATS = [
  "Schedule meeting with the marketing team",
  "Summarize my unread important emails",
  "Reply to investors regarding Q3 report",
  "Find files related to project Alpha",
];

export default function AssistantPage() {
  const router = useRouter();
  const [isMounted, setIsMounted] = useState(false);
  const [isNewChat, setIsNewChat] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<{ id: string; role: "user" | "ai"; content: string }[]>([]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleSend = (text: string) => {
    if (!text.trim()) return;

    const newMessage = { id: Date.now().toString(), role: "user" as const, content: text };
    
    if (isNewChat) {
      setIsNewChat(false);
    }
    
    setMessages((prev) => [...prev, newMessage]);
    setPrompt("");

    // Mock AI response
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "ai",
          content: "Hello! I am Dobbie, your personal executive assistant. I am ready to help you save time today! (Mock Response)",
        },
      ]);
    }, 1000);
  };

  const handleOpenOldChat = (chatTitle: string) => {
    setIsNewChat(false);
    setPrompt("");
    
    // Mock loading a past conversation history
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
              className="w-full bg-transparent border-none outline-none resize-none text-[15px] text-slate-900 placeholder:text-slate-500 py-2 px-1"
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={() => handleSend(prompt)}
                disabled={!prompt.trim()}
                className={`size-8 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
                  prompt.trim() ? "bg-black text-white hover:bg-slate-800" : "bg-slate-200 text-slate-400 cursor-not-allowed"
                }`}
              >
                <SendIcon className="size-4 ml-0.5" />
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
