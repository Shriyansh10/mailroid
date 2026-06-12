"use client";

import { authClient, useSession } from "@web/lib/auth-client";

const Dashboard = () => {
  const { data: session, isPending } = useSession();

  return (
    <>
      <p>{isPending ? "Loading..." : `Logged in as ${session?.user.email ?? "Unknown User"}`}</p>
      <button onClick={() => authClient.signOut()}>Logout</button>
    </>
  );
};

export default Dashboard;
