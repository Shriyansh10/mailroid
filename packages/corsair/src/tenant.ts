// @ts-ignore
import { corsair } from "./corsair";

export const getTenant = (userId: string) => {
  return corsair.withTenant(userId);
};
