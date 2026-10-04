#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyze, explainPath } from './analyze.js';
import { parseRules } from './matcher.js';
import { validateTree } from './tree.js';
import { runDemo } from './demo.js';
import { openDatabase } from './db.js';
import { AnalyzerService } from './service.js';
import { AnalyzerError } from './errors.js';
import { startApiServer } from './server.js';

const DEFAULT_DB = resolve('data/gitignore-analyzer.db');

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(token);
    }
  }
  return { command, flags, positional };
}

function help(): string {
  return [
    'gitignore-analyzer (gia) — 离线 Gitignore 规则匹配与目录剪枝解释',
    '',
    '用法:',
    '  gia demo                                     运行内置演示场景',
    '  gia check --rules <file> [--path <p>] [--type file|dir]',
    '                                               纯规则离线匹配（不落库）',
    '  gia analyze --rules <file> --tree <file>     分析整棵虚拟树',
    '  gia import-tree --name <n> --tree <file> [--db <path>]',
    '  gia add-rules --tree <id> --rules <file>',
    '  gia run --tree <id> [--rule-version <n>]     分析并保存不可变报告',
    '  gia explain --tree <id> --path <p> --type file|dir [--rule-version <n>]',
    '  gia diff --tree <id> --a <n> --b <n>        比较两个规则版本',
    '  gia history [--tree <id>]                    列出历史报告',
    '  gia report --id <n> [--out <file>]           读取/导出历史报告 JSON',
    '  gia serve [--port <n>] [--db <path>]         启动 HTTP API（默认空闲端口）',
    '',
    '通用: --db 指定 SQLite 文件（默认 ./data/gitignore-analyzer.db）',
  ].join('\n');
}

async function readJsonFile<T>(file: string): Promise<T> {
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AnalyzerError('INVALID_JSON', `文件不是合法 JSON: ${file}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case '':
    case 'help':
    case '--help':
    case '-h':
      console.log(help());
      return;
    case 'demo':
      console.log(runDemo());
      return;
    case 'check':
      await cmdCheck(args);
      return;
    case 'analyze':
      await cmdAnalyzeStandalone(args);
      return;
    case 'import-tree':
      await withService(args, async (svc) => {
        const name = args.flags.get('name') ?? 'unnamed';
        const nodes = await readJsonFile<{ path: string; type: 'file' | 'dir' }[]>(
          requireFlag(args, 'tree'),
        );
        const tree = svc.importTree(name, nodes);
        console.log(JSON.stringify({ treeId: tree.id, name: tree.name, nodeCount: tree.nodeCount }, null, 2));
      });
      return;
    case 'add-rules':
      await withService(args, async (svc) => {
        const treeId = Number(requireFlag(args, 'tree'));
        const rulesText = await readFile(requireFlag(args, 'rules'), 'utf8');
        const { ruleVersion } = svc.importRules(treeId, rulesText);
        console.log(
          JSON.stringify(
            { treeId, ruleVersionId: ruleVersion.id, version: ruleVersion.version, syntaxVersion: ruleVersion.syntaxVersion },
            null,
            2,
          ),
        );
      });
      return;
    case 'run':
      await withService(args, async (svc) => {
        const treeId = Number(requireFlag(args, 'tree'));
        const v = optionalNumber(args, 'rule-version');
        const { report, reportId } = svc.analyzeTree(treeId, v);
        console.log(JSON.stringify({ reportId, report }, null, 2));
      });
      return;
    case 'explain':
      await withService(args, async (svc) => {
        const treeId = Number(requireFlag(args, 'tree'));
        const path = requireFlag(args, 'path');
        const type = requireFlag(args, 'type') as 'file' | 'dir';
        if (type !== 'file' && type !== 'dir') {
          throw new AnalyzerError('INVALID_REQUEST', "--type 只能是 file 或 dir");
        }
        const ex = svc.explain(treeId, path, type, optionalNumber(args, 'rule-version'));
        console.log(JSON.stringify(ex, null, 2));
      });
      return;
    case 'diff':
      await withService(args, async (svc) => {
        const treeId = Number(requireFlag(args, 'tree'));
        const result = svc.compare(treeId, Number(requireFlag(args, 'a')), Number(requireFlag(args, 'b')));
        console.log(JSON.stringify(result, null, 2));
      });
      return;
    case 'history':
      await withService(args, async (svc) => {
        const treeId = args.flags.has('tree') ? Number(args.flags.get('tree')) : undefined;
        console.log(JSON.stringify({ reports: svc.repo.listReports(treeId) }, null, 2));
      });
      return;
    case 'report':
      await withService(args, async (svc) => {
        const rec = svc.getReport(Number(requireFlag(args, 'id')));
        const json = JSON.stringify(rec, null, 2);
        const out = args.flags.get('out');
        if (out) {
          await writeFile(out, json, 'utf8');
          console.log(`报告已导出: ${out}`);
        } else {
          console.log(json);
        }
      });
      return;
    case 'serve':
      await cmdServe(args);
      return;
    default:
      console.error(`未知命令: ${args.command}\n`);
      console.log(help());
      process.exitCode = 2;
  }
}

function requireFlag(args: ParsedArgs, key: string): string {
  const value = args.flags.get(key);
  if (value === undefined) throw new AnalyzerError('INVALID_REQUEST', `缺少必需参数 --${key}`);
  return value;
}

function optionalNumber(args: ParsedArgs, key: string): number | undefined {
  const value = args.flags.get(key);
  return value === undefined ? undefined : Number(value);
}

async function cmdCheck(args: ParsedArgs): Promise<void> {
  const rulesText = await readFile(requireFlag(args, 'rules'), 'utf8');
  const { rules, diagnostics } = parseRules(rulesText);
  if (diagnostics.length > 0) {
    console.error(JSON.stringify({ ok: false, diagnostics }, null, 2));
    process.exitCode = 1;
    return;
  }
  const path = args.flags.get('path');
  const type = (args.flags.get('type') ?? 'file') as 'file' | 'dir';
  if (!path) {
    console.log(JSON.stringify({ ok: true, ruleCount: rules.length, diagnostics: [] }, null, 2));
    return;
  }
  const ex = explainPath(rulesText, path, type === 'dir' ? 'dir' : 'file');
  console.log(JSON.stringify(ex, null, 2));
}

async function cmdAnalyzeStandalone(args: ParsedArgs): Promise<void> {
  const rulesText = await readFile(requireFlag(args, 'rules'), 'utf8');
  const nodes = await readJsonFile<{ path: string; type: 'file' | 'dir' }[]>(requireFlag(args, 'tree'));
  validateTree(nodes);
  const { report } = analyze({ rulesText, nodes });
  console.log(JSON.stringify(report, null, 2));
}

async function withService(
  args: ParsedArgs,
  fn: (svc: AnalyzerService) => Promise<void> | void,
): Promise<void> {
  const dbFile = resolve(args.flags.get('db') ?? DEFAULT_DB);
  const db = openDatabase(dbFile);
  try {
    await fn(new AnalyzerService(db));
  } finally {
    db.close();
  }
}

async function cmdServe(args: ParsedArgs): Promise<void> {
  const dbFile = resolve(args.flags.get('db') ?? DEFAULT_DB);
  const port = args.flags.has('port') ? Number(args.flags.get('port')) : undefined;
  const api = await startApiServer({ dbFile, port });
  console.log(`Gitignore Analyzer API 已启动: http://127.0.0.1:${api.port}`);
  console.log(`数据文件: ${dbFile}`);
  console.log('按 Ctrl+C 停止服务。');
  const shutdown = (): void => {
    void api.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof AnalyzerError) {
    console.error(
      JSON.stringify(
        { ok: false, error: { code: err.code, message: err.message, details: err.details } },
        null,
        2,
      ),
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
