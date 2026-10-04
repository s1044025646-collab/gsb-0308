import { createServer } from "node:net";

/** 让操作系统分配一个空闲 TCP 端口。 */
export function findFreePort(preferredFrom = 49152): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
  });
}
