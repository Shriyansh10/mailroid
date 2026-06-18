import { Router } from "express";
import { auth } from "../auth/index.js";
import { startCalendarWatch } from "@repo/services/calendar/watch.ts";

export const calendarWatchRouter = Router();

calendarWatchRouter.post("/watch", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: new Headers(req.headers as any),
    });
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = session.user.id;
    console.log(`[api] Manually triggering calendar watch for user: ${userId}`);

    await startCalendarWatch(userId);

    return res.json({
      success: true,
      message: "Google Calendar watch successfully registered.",
    });
  } catch (error) {
    console.error("[api] Failed to trigger manually registered calendar watch:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
