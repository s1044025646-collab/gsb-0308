/**
 * 端到端演示：使用临时 SQLite，依次演示
 * 1) 忽略全部日志再取反单文件 2) 根限定/任意层 3) ** 零层
 * 4) build/ 剪枝使取反失效，再恢复父目录观察变化
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";
import { AnalyzerService } from "./service";
import { TreeNodeInput } from "./types";

const tree: TreeNodeInput[] = [
  { path: "app.log", type: "file" },
  { path: "logs", type: "dir" },
  { path: "logs/a.log", type: "file" },
  { path: "logs/keep.log", type: "file" },
  { path: "src", type: "dir" },
  { path: "src/a.ts", type: "file" },
  { path: "zero", type: "dir" },
  { path: "zero/z.ts", type: "file" },
  { path: "build", type: "dir" },
  { path: "build/keep.txt", type: "file" },
  { path: "build/sub", type: "dir" },
  { path: "build/sub/c.txt", type: "file" },
  { path: "root-only.log", type: "file" },
  { path: "deep", type: "dir" },
  { path: "deep/root-only.log", type: "file" },
];

function banner(title: string): void {
  console.log("\n================ " + title + " ================");
}

function showReport(service: AnalyzerService, label: string, paths: string[]): void {
  const { result } = service.analyze({ save: false });
  console.log(`-- ${label}（忽略 ${result.ignoredCount} / 可见 ${result.visibleCount}）--`);
  for (const path of paths) {
    const r = result.reports.find((x) => x.path === path)!;
    const dec = r.decidingRule ? `L${r.decidingRule.line}:${r.decidingRule.raw}` : "(无)";
    const blocker = r.prunedBy ? ` 阻断祖先=${r.prunedBy.path}` : "";
    console.log(
      `  ${r.ignored ? "[忽略]" : "[可见]"} ${path.padEnd(22)} 直接=${r.directIgnored} 规则=${dec}${blocker}`
    );
  }
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "gia-demo-"));
  const store = new Store(join(dir, "app.sqlite"));
  const service = new AnalyzerService(store);
  service.importTree(tree);

  banner("场景 1：忽略所有 *.log，再取反 logs/keep.log");
  service.importRules("*.log\n!logs/keep.log\n");
  showReport(service, "*.log + !logs/keep.log", ["app.log", "logs/a.log", "logs/keep.log"]);

  banner("场景 2：根目录限定 /root-only.log 与任意层名字 a.ts");
  service.importRules("/root-only.log\na.ts\n");
  showReport(service, "/root-only.log + a.ts", ["root-only.log", "deep/root-only.log", "src/a.ts"]);

  banner("场景 3：双星号 zero/**/z.ts 匹配零层");
  service.importRules("zero/**/z.ts\n");
  showReport(service, "zero/**/z.ts", ["zero/z.ts"]);

  banner("场景 4a：build/ 被忽略，!build/keep.txt 无法越过父目录");
  const v1 = service.importRules("build/\n!build/keep.txt\n").id;
  showReport(service, "build/ + !build/keep.txt", ["build/keep.txt", "build/sub/c.txt"]);
  console.log("  explain build/keep.txt:");
  const ex = service.explain("build/keep.txt");
  console.log(
    `    直接命中取反=${ex.directIgnored === false}，但最终忽略=${ex.ignored}，阻断链=${ex.blockerChain
      .map((b) => b.path)
      .join(" -> ")}`
  );

  banner("场景 4b：新增恢复父目录规则后子文件可取反生效");
  const v2 = service.importRules("build/\n!build/\nbuild/*\n!build/keep.txt\n").id;
  showReport(service, "恢复 build 后", ["build/keep.txt", "build/sub/c.txt"]);

  banner("版本对比（4a -> 4b）");
  const diff = service.compareRuleVersions(v1, v2);
  for (const change of diff.changes) {
    console.log(
      `  ${change.from.ignored ? "忽略" : "可见"} -> ${change.to.ignored ? "忽略" : "可见"}  ${change.path}`
    );
  }

  banner("冻结报告与重启可读性");
  const { reportId } = service.analyze();
  console.log("  已保存报告 id =", reportId, "（位于临时库", dir + "）");
  const loaded = service.getReport(reportId!);
  console.log("  回读报告语法版本 =", loaded.parsed.syntaxVersion, "路径数 =", loaded.parsed.reports.length);

  store.close();
}

main();
