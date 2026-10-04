import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runAnalysis } from "./helpers";
import { TreeNodeInput } from "../types";

function resolveGit(): string | null {
  const candidates: string[] = [];
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(delimiter)) {
      candidates.push(join(dir, "git.exe"), join(dir, "git"));
    }
  }
  candidates.push(
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe"
  );
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

const GIT = resolveGit();

/**
 * 可选对照：用真实 Git 的 check-ignore 验证兼容子集。
 * 环境无 Git 时自动跳过；主实现任何时候都不调用 Git。
 */
test("（有 Git 时）check-ignore 兼容子集对照", { skip: GIT === null }, () => {
  const rules = "*.log\n/root-only.log\nlogs/\nbuild/**\n";
  const nodes: TreeNodeInput[] = [
    { path: "app.log", type: "file" },
    { path: "root-only.log", type: "file" },
    { path: "deep", type: "dir" },
    { path: "deep/root-only.log", type: "file" },
    { path: "logs", type: "dir" },
    { path: "logs/x.txt", type: "file" },
    { path: "src", type: "dir" },
    { path: "src/a.ts", type: "file" },
    { path: "build", type: "dir" },
    { path: "build/nested", type: "dir" },
    { path: "build/nested/c.txt", type: "file" },
  ];

  const { reports } = runAnalysis(rules, nodes);
  const dir = mkdtempSync(join(tmpdir(), "gia-git-"));
  spawnSync(GIT!, ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), rules, "utf8");
  // check-ignore 默认只报告工作区中存在的路径：创建临时占位文件/目录
  for (const node of nodes) {
    const full = join(dir, node.path);
    if (node.type === "dir") mkdirSync(full, { recursive: true });
    else {
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, "", "utf8");
    }
  }

  for (const node of nodes) {
    const target = node.type === "dir" ? node.path + "/" : node.path;
    const res = spawnSync(GIT!, ["check-ignore", "-q", target], { cwd: dir });
    const gitIgnored = res.status === 0;
    const ours = reports.get(node.path)!.ignored;
    assert.equal(
      ours,
      gitIgnored,
      `${target}: 本实现=${ours} git check-ignore=${gitIgnored}`
    );
  }
});
