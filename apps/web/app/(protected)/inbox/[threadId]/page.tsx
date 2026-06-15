"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useThread } from "@web/hooks/api/gmail";
import Link from "next/link";
import DOMPurify from "dompurify";

export default function ThreadDetailPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { data: thread, isLoading, isError, error } = useThread(threadId);

  if (isLoading) {
    return (
      <div style={{ padding: "2rem" }}>
        <p>Loading thread…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: "2rem" }}>
        <p style={{ color: "red" }}>
          Error: {error?.message ?? "Failed to load thread"}
        </p>
        <Link href="/inbox" style={{ color: "#4da6ff" }}>
          ← Back to Inbox
        </Link>
      </div>
    );
  }

  if (!thread) {
    return (
      <div style={{ padding: "2rem" }}>
        <p>Thread not found.</p>
        <Link href="/inbox" style={{ color: "#4da6ff" }}>
          ← Back to Inbox
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
      <Link
        href="/inbox"
        style={{
          color: "#4da6ff",
          textDecoration: "none",
          fontSize: "0.9rem",
        }}
      >
        ← Back to Inbox
      </Link>

      <h1 style={{ marginTop: "1rem", fontSize: "1.5rem" }}>
        {thread.subject}
      </h1>

      <div style={{ marginTop: "2rem" }}>
        {thread.messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              border: "1px solid #333",
              borderRadius: "8px",
              padding: "1.25rem",
              marginBottom: "1rem",
              backgroundColor: "#ffffff",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "0.5rem",
                marginBottom: "0.75rem",
                fontSize: "0.85rem",
                color: "#000",
              }}
            >
              <span>
                <strong style={{ color: "#000" }}>From:</strong> {msg.from}
              </span>
              <span>
                <strong style={{ color: "#000" }}>To:</strong> {msg.to}
              </span>
              <span>{msg.date}</span>
            </div>

            <div
              style={{
                lineHeight: "1.6",
                color: "#000",
                borderTop: "1px solid #222",
                paddingTop: "0.75rem",
              }}
              dangerouslySetInnerHTML={{
                __html: msg.htmlBody
                  ? DOMPurify.sanitize(msg.htmlBody)
                  : DOMPurify.sanitize(msg.body || msg.snippet),
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
