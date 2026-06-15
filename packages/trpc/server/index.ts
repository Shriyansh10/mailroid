import { publicProcedure, router } from "./trpc.js";
import { z } from "zod";

import { healthRouter } from "./routes/health/route.js";
import { authRouter } from "./routes/tenant/route.js";
import { gmailRouter } from "./routes/gmail/route.js";
import { calendarRouter } from "./routes/calendar/route.js";

export const serverRouter = router({
  health: healthRouter,
  auth: authRouter,
  gmail: gmailRouter,
  calendar: calendarRouter,
});

export { createContext } from "./context.js";
export type ServerRouter = typeof serverRouter;
