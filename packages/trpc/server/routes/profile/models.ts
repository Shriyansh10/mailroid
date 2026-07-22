import { z } from "../../schema.js";
import { priorityProfileModel, priorityProfileRecordModel } from "@repo/shared";

export const getProfileOutputModel = priorityProfileRecordModel.nullable();

export const upsertProfileInputModel = z.object({
  data: priorityProfileModel,
  // True when the user actually filled the wizard, false when they skipped
  // (defaults saved). Drives the Settings fillable-vs-readonly state and the
  // priority-tab "fill the form first" nudge.
  completedOnboarding: z.boolean(),
});

export const upsertProfileOutputModel = z.object({
  success: z.boolean(),
});
