import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../limits";
import { compileRules } from "../rules";
import { sortNodes, validateTree } from "../tree";
import { analyzeTree } from "../engine";
import { PathReport, TreeNodeInput } from "../types";

export function runAnalysis(rulesText: string, nodes: TreeNodeInput[]) {
  const rules = compileRules(rulesText, DEFAULT_LIMITS);
  const tree = sortNodes(validateTree(nodes, DEFAULT_LIMITS));
  const reports = analyzeTree(tree, rules, DEFAULT_LIMITS);
  return { rules, tree, reports, get: (p: string): PathReport => reports.get(p)! };
}

export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gia-"));
  return join(dir, "app.sqlite");
}
