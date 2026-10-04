import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { AnalyzerError } from './errors.js';
import { openDatabase } from './db.js';
import { AnalyzerService } from './service.js';
import { DEFAULT_LIMITS, SUPPORTED_SYNTAX_VERSION, type Limits } from './limits.js';

export interface ApiServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
    srv.on('error', reject);
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: unknown, svc: AnalyzerService) => unknown | Promise<unknown>;
}

const routes: Route[] = [
  {
    method: 'POST',
    pattern: /^\/api\/trees$/,
    handler: (_p, body, svc) => {
      const b = body as { name?: string; nodes?: unknown };
      if (!b || typeof b.name !== 'string' || !Array.isArray(b.nodes)) {
        throw new AnalyzerError('INVALID_REQUEST', "请求体需要 { name: string, nodes: TreeNode[] }");
      }
      const tree = svc.importTree(b.name, b.nodes as never);
      return { treeId: tree.id, name: tree.name, nodeCount: tree.nodeCount };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/trees$/,
    handler: (_p, _b, svc) => ({ trees: svc.repo.listTrees() }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/trees\/(\d+)$/,
    handler: (p, _b, svc) => {
      const tree = svc.repo.getTree(Number(p[0]));
      if (!tree) throw new AnalyzerError('TREE_NOT_FOUND', '树不存在', { treeId: Number(p[0]) }, 404);
      return tree;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/validate-rules$/,
    handler: (_p, body, svc) => {
      const b = body as { rulesText?: unknown };
      if (!b || typeof b.rulesText !== 'string') {
        throw new AnalyzerError('INVALID_REQUEST', '请求体需要 { rulesText: string }');
      }
      return svc.validateRules(b.rulesText);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/trees\/(\d+)\/rules$/,
    handler: (p, body, svc) => {
      const b = body as { rulesText?: unknown };
      if (!b || typeof b.rulesText !== 'string') {
        throw new AnalyzerError('INVALID_REQUEST', '请求体需要 { rulesText: string }');
      }
      const { ruleVersion } = svc.importRules(Number(p[0]), b.rulesText);
      return {
        treeId: ruleVersion.treeId,
        ruleVersionId: ruleVersion.id,
        version: ruleVersion.version,
        syntaxVersion: ruleVersion.syntaxVersion,
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/trees\/(\d+)\/rules$/,
    handler: (p, _b, svc) => ({ versions: svc.repo.listRuleVersions(Number(p[0])) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/trees\/(\d+)\/rules\/(\d+)$/,
    handler: (p, _b, svc) => {
      const rec = svc.repo.getRuleVersionByVersion(Number(p[0]), Number(p[1]));
      if (!rec) {
        throw new AnalyzerError('VERSION_NOT_FOUND', '规则版本不存在', { version: Number(p[1]) }, 404);
      }
      return rec;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/trees\/(\d+)\/analyze$/,
    handler: (p, body, svc) => {
      const b = (body ?? {}) as { ruleVersion?: number };
      const { report, reportId } = svc.analyzeTree(Number(p[0]), b.ruleVersion);
      return { reportId, report };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/trees\/(\d+)\/explain$/,
    handler: (p, body, svc) => {
      const b = body as { path?: unknown; type?: unknown; ruleVersion?: number };
      if (!b || typeof b.path !== 'string' || (b.type !== 'file' && b.type !== 'dir')) {
        throw new AnalyzerError('INVALID_REQUEST', "请求体需要 { path: string, type: 'file'|'dir' }");
      }
      return svc.explain(Number(p[0]), b.path, b.type, b.ruleVersion);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/trees\/(\d+)\/diff\/(\d+)\/(\d+)$/,
    handler: (p, _b, svc) => svc.compare(Number(p[0]), Number(p[1]), Number(p[2])),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports$/,
    handler: (_p, _b, svc) => ({ reports: svc.repo.listReports() }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/(\d+)$/,
    handler: (p, _b, svc) => svc.getReport(Number(p[0])),
  },
];

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new AnalyzerError('INVALID_REQUEST', '请求体超过 10MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AnalyzerError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function startApiServer(options: {
  dbFile: string;
  port?: number;
  limits?: Limits;
}): Promise<ApiServer> {
  const db = openDatabase(options.dbFile);
  const svc = new AnalyzerService(db, options.limits ?? DEFAULT_LIMITS);

  const server = createServer(async (req, res) => {
    await handle(req, res, svc);
  });

  const port = options.port ?? (await findFreePort());
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = (server.address() as { port: number }).port;

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            db.close();
            resolve();
          }
        });
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, svc: AnalyzerService): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, syntaxVersion: SUPPORTED_SYNTAX_VERSION });
    return;
  }

  try {
    let body: unknown = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await readBody(req);
    }
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (let i = 1; i < match.length; i++) params[String(i - 1)] = match[i]!;
      const result = await route.handler(params, body, svc);
      sendJson(res, 200, { ok: true, data: result });
      return;
    }
    sendJson(res, 404, {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: `未找到路由: ${req.method} ${url.pathname}` },
    });
  } catch (err) {
    if (err instanceof AnalyzerError) {
      sendJson(res, err.httpStatus, {
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
    } else {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'INTERNAL', message: (err as Error).message },
      });
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function setCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}
