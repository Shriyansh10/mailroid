import { publicProcedure, router } from "./trpc.js";
import { z } from "zod";

import { healthRouter } from "./routes/health/route.js";
import { authRouter } from "./routes/tenant/route.js";
import { gmailRouter } from "./routes/gmail/route.js";
import { calendarRouter } from "./routes/calendar/route.js";
import { assistantRouter } from "./routes/assistant/route.js";
import { profileRouter } from "./routes/profile/route.js";
import { mailTemplatesRouter } from "./routes/mail-templates/route.js";
import { schedulingRouter } from "./routes/scheduling/route.js";

export const serverRouter = router({
  health: healthRouter,
  auth: authRouter,
  gmail: gmailRouter,
  calendar: calendarRouter,
  assistant: assistantRouter,
  profile: profileRouter,
  mailTemplates: mailTemplatesRouter,
  scheduling: schedulingRouter,
});

export { createContext } from "./context.js";
export type ServerRouter = typeof serverRouter;
