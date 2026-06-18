import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mailroid | Sign In",
  description: "Sign in to Mailroid.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
