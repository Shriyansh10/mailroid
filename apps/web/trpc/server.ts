import type { ServerRouter } from "@repo/trpc/client";
import { createTRPCProxyClient } from "@repo/trpc/client";
import { createTRPCHttpBatchClientClient } from "@web/trpc/create-client";

export const api = createTRPCProxyClient<ServerRouter>({
  links: [createTRPCHttpBatchClientClient()],
});

export const apiStreaming = createTRPCProxyClient<ServerRouter>({
  links: [createTRPCHttpBatchClientClient({ enableStreaming: true })],
});
