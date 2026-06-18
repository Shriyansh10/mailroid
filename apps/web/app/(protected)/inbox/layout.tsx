import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Inbox",
  description: "Priority inbox surfacing high-value emails and hiding noise.",
};

import ClientLayout from "./inbox-client";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ClientLayout>{children}</ClientLayout>;
}
