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
      router.replace("/sign-in");
    }
  }, [data, isPending, router]);

  if (isPending) {
    return <div>Loading...</div>;
  }

  if (!data) {
    return null;
  }

  if(data) {
    console.log("User session data:", data);
    }

  return <>{children}</>;
}
