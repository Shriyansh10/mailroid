import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Authorise Plugins",
  description: "Connect your Gmail and Google Calendar accounts to Mailroid.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
