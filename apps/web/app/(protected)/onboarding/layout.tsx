import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Onboarding",
  description: "Set up your Mailroid account.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
