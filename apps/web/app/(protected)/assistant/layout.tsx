import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Assistant",
  description: "AI Executive Assistant Chat for Mailroid.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
