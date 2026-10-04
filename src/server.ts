import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { findFreePort } from "./netutil";
import { AppError, ValidationError } from "./errors";
import { DEFAULT_LIMITS } from "./limits";
import { Store } from "./db";
import { AnalyzerService } from "./service";

interface Context {
  store: Store;
  service: AnalyzerService;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError("PAYLOAD_TOO_LARGE", `请求体超过 ${maxBytes} 字节`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("INVALID_JSON", "请求体不是合法 JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(ctx: Context): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, syntaxVersion: "gitignore-subset/1.0" });
      }

      if (method === "POST" && path === "/rules") {
        const body = (await readJson(req, ctx.service.limits.maxRulesPayloadBytes)) as {
          content?: string;
        };
        if (typeof body.content !== "string") {
          throw new AppError("MISSING_CONTENT", "需要字符串字段 content", 422);
        }
        const result = ctx.service.importRules(body.content);
        return send(res, 201, result);
      }

      if (method === "GET" && path === "/rules") {
        return send(res, 200, { versions: ctx.store.listRules() });
      }

      if (method === "POST" && path === "/trees") {
        const body = await readJson(req, ctx.service.limits.maxTreePayloadBytes);
        const nodes = (body as { nodes?: unknown }).nodes ?? body;
        const result = ctx.service.importTree(nodes);
        return send(res, 201, result);
      }

      if (method === "GET" && path === "/trees") {
        return send(res, 200, { versions: ctx.store.listTrees() });
      }

      if (method === "POST" && path === "/analyze") {
        const body = ((await readJson(req, 64 * 1024)) as {
          treeId?: number;
          ruleVersionId?: number;
          save?: boolean;
        }) ?? {};
        const { result, reportId } = ctx.service.analyze({
          treeId: body.treeId,
          ruleVersionId: body.ruleVersionId,
          save: body.save,
        });
        return send(res, 200, { reportId, result });
      }

      if (method === "POST" && path === "/explain") {
        const body = (await readJson(req, 64 * 1024)) as {
          path?: string;
          treeId?: number;
          ruleVersionId?: number;
        };
        if (typeof body.path !== "string") {
          throw new AppError("MISSING_PATH", "需要字符串字段 path", 422);
        }
        const report = ctx.service.explain(body.path, {
          treeId: body.treeId,
          ruleVersionId: body.ruleVersionId,
        });
        return send(res, 200, report);
      }

      if (method === "GET" && path.startsWith("/reports/")) {
        const id = Number(path.slice("/reports/".length));
        if (!Number.isInteger(id)) throw new AppError("INVALID_ID", "报告 id 必须是整数", 400);
        return send(res, 200, ctx.service.getReport(id));
      }

      if (method === "GET" && path === "/reports") {
        return send(res, 200, { reports: ctx.store.listReports() });
      }

      if (method === "POST" && path === "/compare") {
        const body = (await readJson(req, 64 * 1024)) as {
          versionA?: number;
          versionB?: number;
          treeId?: number;
        };
        const va = body.versionA;
        const vb = body.versionB;
        if (typeof va !== "number" || typeof vb !== "number" || !Number.isInteger(va) || !Number.isInteger(vb)) {
          throw new AppError(
            "MISSING_VERSIONS",
            "需要整数版本号 versionA 与 versionB",
            422
          );
        }
        return send(res, 200, ctx.service.compareRuleVersions(va, vb, body.treeId));
      }

      send(res, 404, { code: "NOT_FOUND", message: `没有路由 ${method} ${path}` });
    } catch (err) {
      if (err instanceof ValidationError) {
        return send(res, err.status, { code: err.code, message: err.message, issues: err.issues });
      }
      if (err instanceof AppError) {
        return send(res, err.status, { code: err.code, message: err.message, details: err.details });
      }
      send(res, 500, { code: "INTERNAL", message: (err as Error).message });
    }
  });
}

async function main(): Promise<void> {
  const requestedPort = Number(process.env.PORT ?? "");
  const dataDir = process.env.DATA_DIR ?? "data";
  const store = new Store(`${dataDir}/app.sqlite`);
  const service = new AnalyzerService(store, DEFAULT_LIMITS);
  const app = createApp({ store, service });
  const port = Number.isInteger(requestedPort) && requestedPort > 0
    ? requestedPort
    : await findFreePort();
  app.listen(port, () => {
    console.log(`[gitignore-analyzer] 数据目录: ${dataDir}`);
    console.log(`[gitignore-analyzer] HTTP 服务已启动: http://127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("启动失败:", err);
    process.exit(1);
  });
}
