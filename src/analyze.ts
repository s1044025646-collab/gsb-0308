import { DEFAULT_LIMITS, SUPPORTED_SYNTAX_VERSION, type Limits } from './limits.js';
import {
  directEffect,
  matchPath,
  parseRules,
  type CompiledRule,
} from './matcher.js';
import { ancestorDirs, parentPath, validateTree } from './tree.js';
import type {
  AnalysisReport,
  Blocker,
  PathExplanation,
  ReportRow,
  RuleHit,
  TreeNode,
} from './types.js';

export interface AnalyzeInput {
  rulesText: string;
  nodes: { path: string; type: 'file' | 'dir' }[];
  treeVersion?: number;
  ruleVersion?: number;
  limits?: Limits;
  createdAt?: string;
}

export interface AnalyzeResult {
  report: AnalysisReport;
  rules: CompiledRule[];
  tree: TreeNode[];
}

function toHit(rule: CompiledRule, matchedPath: string): RuleHit {
  return {
    line: rule.line,
    raw: rule.raw,
    effect: rule.negated ? 'negation' : 'positive',
    matchedPath,
    kind: rule.anchored ? 'anchored' : 'name',
  };
}

/**
 * 核心遍历模型：
 * 1. 每条规则按行序对“直接命中”的路径生效，后出现的覆盖此前规则；
 * 2. 从根做目录遍历：某目录的最终状态若为 ignored，则其子树被剪枝，
 *    子项即便被取反规则直接命中也不可见；
 * 3. 目录被取反规则重新包含后（其父链未被剪枝），继续遍历并按对子项
 *    生效的规则判断。
 */
export function analyze(input: AnalyzeInput): AnalyzeResult {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const { rules } = parseRules(input.rulesText, limits);
  const tree = validateTree(input.nodes, limits);

  const budget = { remaining: limits.matchBudget };
  const typeByPath = new Map<string, 'file' | 'dir'>();
  const segmentsByPath = new Map<string, string[]>();
  for (const node of tree) {
    typeByPath.set(node.path, node.type);
    segmentsByPath.set(node.path, node.segments);
  }

  // 直接命中（不考虑剪枝）
  const directHits = new Map<string, CompiledRule[]>();
  for (const node of tree) {
    directHits.set(
      node.path,
      matchPath(rules, node.path, node.segments, node.type === 'dir', budget),
    );
  }

  // 目录最终忽略状态：按路径深度递增计算（父先于子）
  const dirs = tree
    .filter((n) => n.type === 'dir')
    .sort((a, b) => a.segments.length - b.segments.length || a.path.localeCompare(b.path));
  const dirIgnored = new Map<string, boolean>();
  const dirDecisive = new Map<string, CompiledRule>();

  for (const dir of dirs) {
    let parentBlocked = false;
    for (const anc of ancestorDirs(dir.segments)) {
      if (dirIgnored.get(anc) === true) {
        parentBlocked = true;
        break;
      }
    }
    if (parentBlocked) {
      // 父目录已剪枝：该目录根本不会被遍历到，沿用“不可见”，规则不再评估
      dirIgnored.set(dir.path, true);
      continue;
    }
    const hits = directHits.get(dir.path)!;
    const { ignored, last } = directEffect(hits);
    dirIgnored.set(dir.path, ignored);
    if (last) dirDecisive.set(dir.path, last);
  }

  // 计算每个路径的解释
  const explanations: Record<string, PathExplanation> = {};
  const rows: ReportRow[] = [];
  let ignoredCount = 0;

  // 子树剪枝数：被剪枝的顶级目录（其父未被剪枝）数量
  const prunedRootDirs = new Set<string>();

  for (const node of tree) {
    const hits = directHits.get(node.path)!;
    const { ignored: directIgnored, last: directLast } = directEffect(hits);

    const blockerChain: Blocker[] = [];
    let blocked = false;
    for (const anc of ancestorDirs(node.segments)) {
      if (dirIgnored.get(anc) === true) {
        blocked = true;
        const rule = dirDecisive.get(anc);
        if (rule) blockerChain.push({ dirPath: anc, rule: toHit(rule, anc) });
      }
    }

    const firstBlocker = blocked ? blockerChain[0] ?? null : null;
    let visible: boolean;
    let decisiveRule: RuleHit | null = null;

    if (firstBlocker) {
      visible = false;
      decisiveRule = firstBlocker.rule;
    } else if (node.type === 'dir') {
      const ignored = dirIgnored.get(node.path)!;
      visible = !ignored;
      const rule = dirDecisive.get(node.path);
      decisiveRule = rule ? toHit(rule, node.path) : null;
    } else {
      visible = !directIgnored;
      decisiveRule = directLast ? toHit(directLast, node.path) : null;
    }

    const ignored = !visible;
    if (ignored) ignoredCount++;
    if (firstBlocker) {
      // 统计直接被剪枝（其父未被剪枝）的目录
      const bp = firstBlocker.dirPath;
      const bpSegs = segmentsByPath.get(bp)!;
      const blockedByParent = ancestorDirs(bpSegs).some((a) => dirIgnored.get(a) === true);
      if (!blockedByParent) prunedRootDirs.add(bp);
    }

    const directMatches = hits.map((r) => toHit(r, node.path));
    explanations[node.path] = {
      path: node.path,
      type: node.type,
      directMatches,
      directLastEffect: directLast ? (directLast.negated ? 'negation' : 'positive') : null,
      directIgnored,
      visible,
      ignored,
      decisiveRule,
      blockerChain,
    };

    rows.push({
      path: node.path,
      type: node.type,
      ignored,
      visible,
      directIgnored,
      decisiveLine: decisiveRule?.line ?? null,
      blockerPath: firstBlocker?.dirPath ?? null,
    });
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));

  const report: AnalysisReport = {
    syntaxVersion: SUPPORTED_SYNTAX_VERSION,
    treeVersion: input.treeVersion ?? 0,
    ruleVersion: input.ruleVersion ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
    rows,
    explanations,
    stats: {
      total: tree.length,
      ignored: ignoredCount,
      visible: tree.length - ignoredCount,
      prunedSubtrees: prunedRootDirs.size,
    },
  };

  return { report, rules, tree };
}

/** 解释单条路径：若不在树中则按“孤立路径”计算直接匹配，不做遍历剪枝。 */
export function explainPath(
  rulesText: string,
  path: string,
  type: 'file' | 'dir',
  treeNodes?: { path: string; type: 'file' | 'dir' }[],
  limits: Limits = DEFAULT_LIMITS,
): PathExplanation {
  const { rules } = parseRules(rulesText, limits);
  const segments = path.split('/');
  const budget = { remaining: limits.matchBudget };
  const hits = matchPath(rules, path, segments, type === 'dir', budget);
  const directMatches = hits.map((r) => toHit(r, path));
  const { ignored: directIgnored, last } = directEffect(hits);

  if (!treeNodes) {
    return {
      path,
      type,
      directMatches,
      directLastEffect: last ? (last.negated ? 'negation' : 'positive') : null,
      directIgnored,
      visible: !directIgnored,
      ignored: directIgnored,
      decisiveRule: last ? toHit(last, path) : null,
      blockerChain: [],
    };
  }

  // 在完整树上下文中复用 analyze，保证剪枝链准确
  const { report } = analyze({ rulesText, nodes: treeNodes, limits });
  const existing = report.explanations[path];
  if (existing) return existing;
  return {
    path,
    type,
    directMatches,
    directLastEffect: last ? (last.negated ? 'negation' : 'positive') : null,
    directIgnored,
    visible: !directIgnored,
    ignored: directIgnored,
    decisiveRule: last ? toHit(last, path) : null,
    blockerChain: [],
  };
}

export interface RuleVersionDiff {
  ruleVersionA: number;
  ruleVersionB: number;
  addedLines: number[];
  removedLines: number[];
  changedPaths: {
    path: string;
    ignoredA: boolean;
    ignoredB: boolean;
    decisiveA: number | null;
    decisiveB: number | null;
  }[];
}

/** 用同一棵树比较两个规则版本的最终可见性差异。 */
export function diffRuleVersions(
  nodes: { path: string; type: 'file' | 'dir' }[],
  rulesA: { text: string; version: number },
  rulesB: { text: string; version: number },
  limits: Limits = DEFAULT_LIMITS,
): RuleVersionDiff {
  const a = analyze({ rulesText: rulesA.text, nodes, ruleVersion: rulesA.version, limits }).report;
  const b = analyze({ rulesText: rulesB.text, nodes, ruleVersion: rulesB.version, limits }).report;

  const changedPaths: RuleVersionDiff['changedPaths'] = [];
  const mapB = new Map(b.rows.map((r) => [r.path, r]));
  for (const rowA of a.rows) {
    const rowB = mapB.get(rowA.path);
    if (!rowB || rowB.ignored !== rowA.ignored || rowB.decisiveLine !== rowA.decisiveLine) {
      changedPaths.push({
        path: rowA.path,
        ignoredA: rowA.ignored,
        ignoredB: rowB ? rowB.ignored : false,
        decisiveA: rowA.decisiveLine,
        decisiveB: rowB ? rowB.decisiveLine : null,
      });
    }
  }
  for (const rowB of b.rows) {
    if (!a.explanations[rowB.path]) {
      changedPaths.push({
        path: rowB.path,
        ignoredA: false,
        ignoredB: rowB.ignored,
        decisiveA: null,
        decisiveB: rowB.decisiveLine,
      });
    }
  }

  return {
    ruleVersionA: rulesA.version,
    ruleVersionB: rulesB.version,
    addedLines: lineDiff(rulesA.text, rulesB.text).added,
    removedLines: lineDiff(rulesA.text, rulesB.text).removed,
    changedPaths,
  };
}

function lineDiff(a: string, b: string): { added: number[]; removed: number[] } {
  const la = a.split(/\r\n|\r|\n/);
  const lb = b.split(/\r\n|\r|\n/);
  const setB = new Set(lb);
  const setA = new Set(la);
  const removed = la.map((line, i) => (setB.has(line) ? -1 : i + 1)).filter((n) => n !== -1);
  const added = lb.map((line, i) => (setA.has(line) ? -1 : i + 1)).filter((n) => n !== -1);
  return { added, removed };
}

export { parentPath };
