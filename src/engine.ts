import { AppError } from "./errors";
import { DEFAULT_LIMITS, LimitConfig } from "./limits";
import { matchSegments } from "./rules";
import { Blocker, CompiledRule, NodeType, PathReport, RuleMatch, TreeNode } from "./types";

function toMatch(rule: CompiledRule): RuleMatch {
  return { line: rule.line, raw: rule.raw, negated: rule.negated };
}

/** 判断单条规则是否命中给定路径（dirOnly 时要求目标是目录）。 */
export function ruleMatches(
  rule: CompiledRule,
  segments: string[],
  type: NodeType,
  budget: { used: number; max: number }
): boolean {
  if (rule.dirOnly && type !== "dir") return false;
  if (rule.anchored) {
    return matchSegments(rule.patterns, segments, budget);
  }
  // 名字模式：在任意层（含根层）匹配某一段
  const [namePattern] = rule.patterns;
  for (const seg of segments) {
    budget.used++;
    if (budget.used > budget.max) throw new AppError("MATCH_BUDGET_EXCEEDED", "匹配预算超限", 422);
    if (namePattern.kind === "glob" && namePattern.regex.test(seg)) return true;
  }
  return false;
}

export interface DirectResult {
  ignored: boolean;
  matches: RuleMatch[];
  decidingRule: RuleMatch | null;
}

/** 直接模式匹配：后出现的规则覆盖前者，不考虑父目录剪枝。 */
export function matchDirect(
  rules: CompiledRule[],
  segments: string[],
  type: NodeType,
  limits: LimitConfig = DEFAULT_LIMITS
): DirectResult {
  const budget = { used: 0, max: limits.matchBudget };
  const matches: RuleMatch[] = [];
  let ignored = false;
  let decidingRule: RuleMatch | null = null;
  for (const rule of rules) {
    if (ruleMatches(rule, segments, type, budget)) {
      matches.push(toMatch(rule));
      ignored = !rule.negated;
      decidingRule = toMatch(rule);
    }
  }
  return { ignored, matches, decidingRule };
}

/**
 * 从根遍历整棵树，模拟目录剪枝。
 * 进入某目录时：若最终被忽略则整棵子树被剪掉，子项不再评估任何规则
 * （即使子项有取反规则也无法越过被排除的父目录）。
 */
export function analyzeTree(
  nodes: TreeNode[],
  rules: CompiledRule[],
  limits: LimitConfig = DEFAULT_LIMITS
): Map<string, PathReport> {
  const byPath = new Map<string, TreeNode>();
  const children = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    byPath.set(node.path, node);
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }

  const reports = new Map<string, PathReport>();

  interface Frame {
    node: TreeNode;
    /** 若祖先链存在被剪枝目录，记录整条链；否则为 null */
    blockerChain: Blocker[];
    prunedHere: boolean;
  }

  const visit = (node: TreeNode, ancestorBlockers: Blocker[]) => {
    const direct = matchDirect(rules, node.segments, node.type, limits);
    let ignored: boolean;
    let decidingRule: RuleMatch | null;
    let blockerChain: Blocker[] = ancestorBlockers;
    let prunedBy: Blocker | null = ancestorBlockers.length > 0 ? ancestorBlockers[0] : null;
    let parentPruned = ancestorBlockers.length > 0;

    if (ancestorBlockers.length > 0) {
      // 祖先被排除：子树剪掉，直接匹配结论仅作展示，不改变结果
      ignored = true;
      decidingRule = toMatchFromBlocker(ancestorBlockers[0]);
    } else {
      ignored = direct.ignored;
      decidingRule = direct.decidingRule;
      prunedBy = null;
      parentPruned = false;
    }

    const report: PathReport = {
      path: node.path,
      type: node.type,
      directIgnored: direct.ignored,
      directMatches: direct.matches,
      directDecidingRule: direct.decidingRule,
      ignored,
      decidingRule,
      blockerChain,
      prunedBy,
      parentPruned,
    };
    reports.set(node.path, report);

    const kids = children.get(node.path) ?? [];
    if (node.type !== "dir") return;

    if (ancestorBlockers.length === 0 && ignored) {
      // 本目录在本层被判定忽略：成为新的剪枝点，整棵子树剪掉
      const blocker: Blocker = {
        path: node.path,
        line: decidingRule?.line ?? -1,
        raw: decidingRule?.raw ?? "",
      };
      for (const kid of kids) visit(kid, [blocker]);
    } else if (ancestorBlockers.length > 0) {
      // 继续透传阻断链
      for (const kid of kids) visit(kid, ancestorBlockers);
    } else {
      // 目录可见（含被取反恢复）：子项按各自规则独立判断
      for (const kid of kids) visit(kid, []);
    }
  };

  for (const rootNode of children.get(null) ?? []) visit(rootNode, []);
  return reports;
}

function toMatchFromBlocker(blocker: Blocker): RuleMatch {
  return { line: blocker.line, raw: blocker.raw, negated: false };
}

/** 解释单个路径：返回直接匹配与遍历后结论。 */
export function explainPath(
  nodes: TreeNode[],
  rules: CompiledRule[],
  targetPath: string,
  limits: LimitConfig = DEFAULT_LIMITS
): PathReport {
  const reports = analyzeTree(nodes, rules, limits);
  const report = reports.get(targetPath);
  if (!report) throw new AppError("PATH_NOT_IN_TREE", `路径 "${targetPath}" 不在虚拟树中`, 404);
  return report;
}
