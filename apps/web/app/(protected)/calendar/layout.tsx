import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Calendar",
  description: "Manage meetings, invitations, and schedules from one place.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
