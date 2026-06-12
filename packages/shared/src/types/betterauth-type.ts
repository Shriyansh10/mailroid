import { z } from "zod";

// 1. Zod schemas (runtime values)
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  image: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const sessionSchema = z.object({
  id: z.string(),
  expiresAt: z.date(),
  token: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  userId: z.string(),
});

export const authOutputSchema = z.object({
  session: sessionSchema.nullable(),
  user: userSchema.nullable(),
});

// 2. TypeScript types inferred FROM the schemas
export type UserType = z.infer<typeof userSchema>;
export type SessionType = z.infer<typeof sessionSchema>;


