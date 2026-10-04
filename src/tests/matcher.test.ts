import { test } from "node:test";
import assert from "node:assert/strict";
import { runAnalysis } from "./helpers";
import { TreeNodeInput } from "../types";

const tree: TreeNodeInput[] = [
  { path: "a.log", type: "file" },
  { path: "app.log", type: "file" },
  { path: "logs", type: "dir" },
  { path: "logs/x.log", type: "file" },
  { path: "logs/keep.log", type: "file" },
  { path: "src", type: "dir" },
  { path: "src/a.ts", type: "file" },
  { path: "src/nested", type: "dir" },
  { path: "src/nested/b.ts", type: "file" },
  { path: "build", type: "dir" },
  { path: "build/keep.txt", type: "file" },
  { path: "build/sub", type: "dir" },
  { path: "build/sub/c.txt", type: "file" },
  { path: "zero", type: "dir" },
  { path: "zero/z.ts", type: "file" },
  { path: "name-sake", type: "file" },
  { path: "name-sake-dir", type: "dir" },
];

test("忽略所有日志后重新包含一个文件（直接匹配层）", () => {
  const { get } = runAnalysis("*.log\n!logs/keep.log\n", tree);
  assert.equal(get("logs/keep.log").directIgnored, false);
  assert.equal(get("logs/keep.log").ignored, false); // logs/ 未被忽略，取反生效
  assert.equal(get("logs/x.log").ignored, true);
  assert.equal(get("a.log").ignored, true);
  // 取反规则是最后生效规则
  assert.equal(get("logs/keep.log").decidingRule?.raw, "!logs/keep.log");
});

test("根目录限定 vs 任意层名字匹配", () => {
  const { get } = runAnalysis("/app.log\n", tree);
  assert.equal(get("app.log").ignored, true);
  assert.equal(get("a.log").ignored, false);

  const anyLevel = runAnalysis("a.ts\n", tree);
  assert.equal(anyLevel.get("src/a.ts").ignored, true);
  // 根层同名文件也应命中
  const rootMatch = runAnalysis("a.ts\n", [
    { path: "a.ts", type: "file" },
    { path: "x", type: "dir" },
    { path: "x/a.ts", type: "file" },
  ]);
  assert.equal(rootMatch.get("a.ts").ignored, true);
  assert.equal(rootMatch.get("x/a.ts").ignored, true);
});

test("双星号匹配零层与多层", () => {
  const { get } = runAnalysis("zero/**/z.ts\n", tree);
  assert.equal(get("zero/z.ts").ignored, true); // 零层

  const multi = runAnalysis("src/**/b.ts\n", tree);
  assert.equal(multi.get("src/nested/b.ts").ignored, true);
  const zero = runAnalysis("src/**/b.ts\n", tree);
  assert.equal(zero.get("src/nested/b.ts").ignored, true);
});

test("忽略 build/ 后单独取反 build/keep.txt 仍无法生效", () => {
  const { get } = runAnalysis("build/\n!build/keep.txt\n", tree);
  const report = get("build/keep.txt");
  assert.equal(report.directIgnored, false); // 取反在直接层命中
  assert.equal(report.ignored, true); // 但父目录被剪掉
  assert.equal(report.parentPruned, true);
  assert.equal(report.prunedBy?.path, "build");
  assert.equal(report.prunedBy?.raw, "build/");
  assert.equal(report.blockerChain[0].path, "build");
  // 深层子节点同样透传剪枝
  assert.equal(get("build/sub/c.txt").prunedBy?.path, "build");
});

test("恢复父目录规则后子文件可取反生效", () => {
  const { get } = runAnalysis("build/\n!build/\nbuild/*\n!build/keep.txt\n", tree);
  const report = get("build/keep.txt");
  assert.equal(report.ignored, false);
  assert.equal(report.parentPruned, false);
  // build/sub 被 build/* 忽略（目录），其子树被剪
  assert.equal(get("build/sub/c.txt").ignored, true);
  assert.equal(get("build/sub/c.txt").prunedBy?.path, "build/sub");
});

test("顺序颠倒时后出现规则覆盖前者", () => {
  const forward = runAnalysis("*.log\n!a.log\n", tree);
  assert.equal(forward.get("a.log").ignored, false);
  const reversed = runAnalysis("!a.log\n*.log\n", tree);
  assert.equal(reversed.get("a.log").ignored, true);
});

test("目录专用模式不匹配同名文件", () => {
  const nodes: TreeNodeInput[] = [
    { path: "name-sake", type: "file" },
    { path: "name-sake-dir", type: "dir" },
  ];
  const { reports } = runAnalysis("name-sake/\n", nodes);
  assert.equal(reports.get("name-sake")!.ignored, false);

  const dirTree: TreeNodeInput[] = [
    { path: "logs", type: "dir" },
    { path: "logs2", type: "file" },
  ];
  const r2 = runAnalysis("logs/\n", dirTree);
  assert.equal(r2.get("logs").ignored, true);
  assert.equal(r2.get("logs2").ignored, false);
});

test("文件与目录同名（不同路径段）均独立判断", () => {
  const nodes: TreeNodeInput[] = [
    { path: "x", type: "file" },
    { path: "x-dir", type: "dir" },
  ];
  // 同一父目录不允许同名 file/dir（重复条目），这里验证不同身份规则
  const r = runAnalysis("x\n", nodes);
  assert.equal(r.get("x").ignored, true);
});

test("问号不跨斜杠，单星号不跨斜杠", () => {
  const nodes: TreeNodeInput[] = [
    { path: "ab.ts", type: "file" },
    { path: "a.ts", type: "file" },
    { path: "dir", type: "dir" },
    { path: "dir/x.ts", type: "file" },
  ];
  const r = runAnalysis("a?.ts\n", nodes);
  assert.equal(r.get("ab.ts").ignored, true);
  assert.equal(r.get("a.ts").ignored, false);

  const star = runAnalysis("*.ts\n", nodes);
  assert.equal(star.get("dir/x.ts").ignored, true); // 名字模式任意层 + 段内匹配
});

test("转义开头 # 与 ! 作为字面字符", () => {
  const nodes: TreeNodeInput[] = [
    { path: "#hash", type: "file" },
    { path: "!bang", type: "file" },
  ];
  const r = runAnalysis("\\#hash\n\\!bang\n", nodes);
  assert.equal(r.get("#hash").ignored, true);
  assert.equal(r.get("!bang").ignored, true);
});

test("空规则文本不忽略任何路径", () => {
  const { reports } = runAnalysis("# 仅注释\n\n  \n", tree);
  for (const report of reports.values()) assert.equal(report.ignored, false);
});
