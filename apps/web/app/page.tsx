
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";

export default async function Home() {
  const cookieStore = await cookies();
  const heads = await headers();

  const res = await fetch("http://localhost:8000/api/auth/get-session", {
    headers: {
      ...Object.fromEntries(heads.entries()),
      Cookie: cookieStore
        .getAll()
        .map((c) => `${c.name}=${c.value}`)
        .join("; "),
    },
    cache: "no-store",
  });

  const session = await res.json().catch(() => null);

  if (session?.user) {
    redirect("/onboarding");
  }

  redirect("/sign-in");
}
