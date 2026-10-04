import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../db";
import { AnalyzerService } from "../service";
import { tempDbPath } from "./helpers";
import { TreeNodeInput } from "../types";

const tree: TreeNodeInput[] = [
  { path: "build", type: "dir" },
  { path: "build/keep.txt", type: "file" },
  { path: "app.log", type: "file" },
];

function freshService(dbPath: string) {
  const store = new Store(dbPath);
  return { store, service: new AnalyzerService(store) };
}

test("输入节点重排不改变结果", () => {
  const { service } = freshService(tempDbPath());
  service.importRules("build/\n");
  service.importTree(tree);
  const r1 = service.analyze({ save: false }).result;

  const { service: s2 } = freshService(tempDbPath());
  s2.importRules("build/\n");
  s2.importTree([...tree].reverse());
  const r2 = s2.analyze({ save: false }).result;

  assert.deepEqual(
    r1.reports.map((r) => [r.path, r.ignored, r.prunedBy?.path ?? null]),
    r2.reports.map((r) => [r.path, r.ignored, r.prunedBy?.path ?? null])
  );
});

test("报告冻结：重启后旧报告完整可读，删除/修改规则不影响历史", () => {
  const dbPath = tempDbPath();
  const { store, service } = freshService(dbPath);
  service.importRules("*.log\n");
  service.importTree(tree);
  const { reportId } = service.analyze();
  assert.ok(reportId);
  store.close();

  // 重启，导入全新规则集（历史规则行仍在，但旧报告是快照）
  const reopened = freshService(dbPath);
  const oldReport = reopened.service.getReport(reportId!);
  assert.equal(oldReport.parsed.ignoredCount, 1);
  assert.equal(oldReport.parsed.reports.find((r) => r.path === "app.log")!.ignored, true);

  reopened.service.importRules("nomatch\n");
  const newResult = reopened.service.analyze({ save: false }).result;
  assert.equal(newResult.ignoredCount, 0);
  // 旧报告不变
  const oldAgain = reopened.service.getReport(reportId!);
  assert.equal(oldAgain.parsed.ignoredCount, 1);
  assert.equal(oldAgain.parsed.syntaxVersion, "gitignore-subset/1.0");
  reopened.store.close();
});

test("规则版本对比：差异路径被列出", () => {
  const { store, service } = freshService(tempDbPath());
  service.importTree(tree);
  const v1 = service.importRules("*.log\n").id;
  const v2 = service.importRules("*.log\n!app.log\n").id;
  const diff = service.compareRuleVersions(v1, v2);
  const changed = diff.changes.find((c) => c.path === "app.log");
  assert.ok(changed);
  assert.equal(changed!.from.ignored, true);
  assert.equal(changed!.to.ignored, false);
  store.close();
});

test("非法规则导入失败且不产生新版本", () => {
  const { store, service } = freshService(tempDbPath());
  assert.throws(
    () => service.importRules("foo[bar]\n"),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "VALIDATION_FAILED"
  );
  assert.equal(store.listRules().length, 0);
  store.close();
});
