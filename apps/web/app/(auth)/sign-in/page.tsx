'use client'

import { authClient } from "@web/lib/auth-client";

export default function Page() {


  const handleGoogleLogin = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "http://localhost:3000/authorise-plugins",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 rounded-xl border p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Mailroid</h1>

        <p className="text-muted-foreground text-sm">Sign in with Google to continue</p>

        <button
          onClick={handleGoogleLogin}
          className="inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}
