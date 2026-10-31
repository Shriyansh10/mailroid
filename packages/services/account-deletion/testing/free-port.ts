import { createServer, type AddressInfo } from "node:net";

/**
 * A port the OS says is free right now. A random pick from a fixed range is not
 * enough on Windows: Hyper-V reserves blocks (55072-55434 on the dev machine),
 * and a reserved port fails with EACCES before any test runs.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
