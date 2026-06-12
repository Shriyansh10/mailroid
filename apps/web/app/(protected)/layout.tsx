// app/(protected)/layout.tsx

"use client";

import { useSession } from "@web/lib/auth-client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && !data) {
      router.replace("/signin");
    }
  }, [data, isPending, router]);

  if (isPending) {
    return <div>Loading...</div>;
  }

  if (!data) {
    return null;
  }

  return <>{children}</>;
}
