import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth";

export const authHandler = toNodeHandler(auth);
