import { corsair } from "./corsair.js";

export const getTenant = (userId: string) => {
  return corsair.withTenant(userId);
};
