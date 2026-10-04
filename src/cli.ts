#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppError, ValidationError } from "./errors";
import { DEFAULT_LIMITS } from "./limits";
import { Store } from "./db";
import { AnalyzerService } from "./service";

function usage(): string {
  return [
    "用法: gitignore-analyzer <命令> [参数]",
    "",
    "命令:",
    "  import-rules <规则文件>            导入规则文本，产生新规则版本",
    "  import-tree <树JSON文件>           导入虚拟树（节点数组或 {nodes:[...]}）",
    "  analyze [--tree ID] [--rules ID] [--no-save] [--out 文件.json]",
    "                                     分析全部路径（默认保存为冻结报告）",
    "  explain <相对路径> [--tree ID] [--rules ID]",
    "                                     解释单条路径的直接匹配与遍历结论",
    "  compare <规则版本A> <规则版本B> [--tree ID]",
    "                                     比较两个规则版本的最终可见性差异",
    "  history [--reports|--rules|--trees] 列出历史",
    "  report <报告ID> [--out 文件.json]   读取冻结的历史报告（JSON）",
    "",
    "环境变量:",
    "  DATA_DIR   数据目录（默认 ./data）",
  ].join("\n");
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function numFlag(flags: Map<string, string | boolean>, key: string): number | undefined {
  const value = flags.get(key);
  if (value === undefined || value === true) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new AppError("INVALID_ID", `--${key} 必须是整数`);
  return n;
}

function outputJson(data: unknown, out?: string): void {
  const json = JSON.stringify(data, null, 2);
  if (out) {
    writeFileSync(resolve(out), json, "utf8");
    console.log(`已写入 ${out}`);
  } else {
    console.log(json);
  }
}

function loadJsonFile(file: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (err) {
    throw new AppError("INVALID_JSON", `无法解析 ${file}: ${(err as Error).message}`);
  }
  return parsed;
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(usage());
    return;
  }

  const dataDir = process.env.DATA_DIR ?? "data";
  const store = new Store(`${dataDir}/app.sqlite`);
  const service = new AnalyzerService(store, DEFAULT_LIMITS);

  try {
    const { positional, flags } = parseFlags(argv.slice(1));
    switch (command) {
      case "import-rules": {
        const file = positional[0];
        if (!file) throw new AppError("MISSING_ARG", "缺少规则文件路径");
        const content = readFileSync(resolve(file), "utf8");
        console.log(JSON.stringify(service.importRules(content), null, 2));
        break;
      }
      case "import-tree": {
        const file = positional[0];
        if (!file) throw new AppError("MISSING_ARG", "缺少树 JSON 文件路径");
        const parsed = loadJsonFile(file);
        const nodes = (parsed as { nodes?: unknown }).nodes ?? parsed;
        console.log(JSON.stringify(service.importTree(nodes), null, 2));
        break;
      }
      case "analyze": {
        const { result, reportId } = service.analyze({
          treeId: numFlag(flags, "tree"),
          ruleVersionId: numFlag(flags, "rules"),
          save: !flags.has("no-save"),
        });
        outputJson({ reportId, result }, flags.get("out") as string | undefined);
        break;
      }
      case "explain": {
        const target = positional[0];
        if (!target) throw new AppError("MISSING_ARG", "缺少要解释的相对路径");
        const report = service.explain(target, {
          treeId: numFlag(flags, "tree"),
          ruleVersionId: numFlag(flags, "rules"),
        });
        outputJson(report, flags.get("out") as string | undefined);
        break;
      }
      case "compare": {
        const a = Number(positional[0]);
        const b = Number(positional[1]);
        if (!Number.isInteger(a) || !Number.isInteger(b)) {
          throw new AppError("MISSING_VERSIONS", "用法: compare <规则版本A> <规则版本B>");
        }
        outputJson(
          service.compareRuleVersions(a, b, numFlag(flags, "tree")),
          flags.get("out") as string | undefined
        );
        break;
      }
      case "history": {
        if (flags.has("rules")) console.log(JSON.stringify(store.listRules(), null, 2));
        else if (flags.has("trees")) console.log(JSON.stringify(store.listTrees(), null, 2));
        else console.log(JSON.stringify(store.listReports(), null, 2));
        break;
      }
      case "report": {
        const id = Number(positional[0]);
        if (!Number.isInteger(id)) throw new AppError("MISSING_ARG", "用法: report <报告ID>");
        outputJson(service.getReport(id).parsed, flags.get("out") as string | undefined);
        break;
      }
      default:
        throw new AppError("UNKNOWN_COMMAND", `未知命令: ${command}\n\n${usage()}`, 400);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(JSON.stringify({ code: err.code, issues: err.issues }, null, 2));
      process.exitCode = 1;
    } else if (err instanceof AppError) {
      console.error(JSON.stringify({ code: err.code, message: err.message }, null, 2));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    store.close();
  }
}

main();
