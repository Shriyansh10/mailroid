import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Settings",
  description: "Manage your Mailroid account and preferences.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
