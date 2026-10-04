import { AppError } from "./errors";
import { DEFAULT_LIMITS, LimitConfig } from "./limits";
import { analyzeTree, explainPath } from "./engine";
import { compileRules } from "./rules";
import { Store, buildAnalysisResult } from "./db";
import { sortNodes, validateTree } from "./tree";
import { AnalysisResult, PathReport } from "./types";

export class AnalyzerService {
  constructor(
    private readonly store: Store,
    readonly limits: LimitConfig = DEFAULT_LIMITS
  ) {}

  /** 导入规则：先完整校验/编译，任何非法规则都会失败且不落库。 */
  importRules(text: string): { id: number; ruleCount: number } {
    const compiled = compileRules(text, this.limits);
    const id = this.store.insertRules(text);
    return { id, ruleCount: compiled.length };
  }

  /** 导入虚拟树：校验通过后作为新版本落库。 */
  importTree(rawNodes: unknown): { id: number; nodeCount: number } {
    const nodes = validateTree(rawNodes, this.limits);
    const id = this.store.insertTree(JSON.stringify(nodes));
    return { id, nodeCount: nodes.length };
  }

  private loadTree(treeId: number | null) {
    const id = treeId ?? this.store.activeRefs().treeId;
    if (id === null) throw new AppError("NO_TREE", "尚未导入虚拟树", 409);
    const row = this.store.getTree(id);
    if (!row) throw new AppError("TREE_NOT_FOUND", `树版本 ${id} 不存在`, 404);
    return { id, nodes: sortNodes(validateTree(JSON.parse(row.payload), this.limits)) };
  }

  private loadRules(ruleVersionId: number | null) {
    const id = ruleVersionId ?? this.store.activeRefs().ruleVersionId;
    if (id === null) throw new AppError("NO_RULES", "尚未导入规则", 409);
    const row = this.store.getRules(id);
    if (!row) throw new AppError("RULES_NOT_FOUND", `规则版本 ${id} 不存在`, 404);
    // 历史规则已在导入时校验；这里再次编译用于匹配
    return { id, rules: compileRules(row.content, this.limits), content: row.content };
  }

  /** 分析全部路径并冻结保存报告（报告保存后不再随后续编辑变化）。 */
  analyze(opts?: { treeId?: number; ruleVersionId?: number; save?: boolean }): {
    result: AnalysisResult;
    reportId: number | null;
  } {
    const tree = this.loadTree(opts?.treeId ?? null);
    const rules = this.loadRules(opts?.ruleVersionId ?? null);
    const reports = analyzeTree(tree.nodes, rules.rules, this.limits);
    const result = buildAnalysisResult(reports, rules.id, tree.id);
    let reportId: number | null = null;
    if (opts?.save !== false) reportId = this.store.saveReport(tree.id, rules.id, result);
    return { result, reportId };
  }

  explain(targetPath: string, opts?: { treeId?: number; ruleVersionId?: number }): PathReport {
    const tree = this.loadTree(opts?.treeId ?? null);
    const rules = this.loadRules(opts?.ruleVersionId ?? null);
    return explainPath(tree.nodes, rules.rules, targetPath, this.limits);
  }

  getReport(id: number) {
    const report = this.store.getReport(id);
    if (!report) throw new AppError("REPORT_NOT_FOUND", `报告 ${id} 不存在`, 404);
    return report;
  }

  /** 比较两个规则版本在同一棵树上的最终可见性差异。 */
  compareRuleVersions(versionA: number, versionB: number, treeId?: number) {
    const tree = this.loadTree(treeId ?? null);
    const a = this.loadRules(versionA);
    const b = this.loadRules(versionB);
    const reportsA = analyzeTree(tree.nodes, a.rules, this.limits);
    const reportsB = analyzeTree(tree.nodes, b.rules, this.limits);
    const changes: Array<{
      path: string;
      type: string;
      from: { ignored: boolean; line: number | null; raw: string | null };
      to: { ignored: boolean; line: number | null; raw: string | null };
    }> = [];
    for (const node of tree.nodes) {
      const ra = reportsA.get(node.path)!;
      const rb = reportsB.get(node.path)!;
      if (ra.ignored !== rb.ignored || ra.decidingRule?.line !== rb.decidingRule?.line) {
        changes.push({
          path: node.path,
          type: node.type,
          from: {
            ignored: ra.ignored,
            line: ra.decidingRule?.line ?? null,
            raw: ra.decidingRule?.raw ?? null,
          },
          to: {
            ignored: rb.ignored,
            line: rb.decidingRule?.line ?? null,
            raw: rb.decidingRule?.raw ?? null,
          },
        });
      }
    }
    return {
      treeId: tree.id,
      versionA: { id: a.id, content: a.content },
      versionB: { id: b.id, content: b.content },
      changedCount: changes.length,
      changes,
    };
  }
}
