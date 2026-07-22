// Internal specifiers use .ts extensions (matching @repo/database and
// @repo/ai): this package ships raw TypeScript, and Turbopack cannot resolve
// a ".js" specifier that has no emitted .js file behind it.
export { userSchema, sessionSchema, authOutputSchema } from "./types/betterauth-type.ts";
export type { UserType, SessionType } from "./types/betterauth-type.ts";

export {
  priorityProfileModel,
  priorityProfileRecordModel,
  DEFAULT_PRIORITY_PROFILE,
  sanitizeDomainInput,
  sanitizeTagInput,
  normalizePriorityProfile,
} from "./schemas/priority-profile.ts";
export type {
  PriorityProfile,
  PriorityProfileRecord,
} from "./schemas/priority-profile.ts";
export * from "./schemas/priority-profile-config.ts";
export { buildProfilePreview } from "./schemas/priority-profile-preview.ts";
