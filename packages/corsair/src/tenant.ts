import { corsair } from "./corsair.ts";

export const getTenant = (userId: string) => {
  return corsair.withTenant(userId);
};
