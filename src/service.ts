import type { DatabaseSync } from 'node:sqlite';
import { analyze, diffRuleVersions, explainPath } from './analyze.js';
import { AnalyzerError, type Diagnostic } from './errors.js';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { parseRules } from './matcher.js';
import { Repository, type ReportRecord, type RuleVersionRecord, type TreeRecord } from './repository.js';
import type { AnalysisReport, PathExplanation, TreeNodeInput } from './types.js';

export class AnalyzerService {
  readonly repo: Repository;
  readonly limits: Limits;

  constructor(db: DatabaseSync, limits: Limits = DEFAULT_LIMITS) {
    this.repo = new Repository(db);
    this.limits = limits;
  }

  /** 校验规则：存在任何诊断都视为整体失败，绝不静默跳过。 */
  validateRules(rulesText: string): { diagnostics: Diagnostic[] } {
    const { diagnostics } = parseRules(rulesText, this.limits);
    return { diagnostics };
  }

  importTree(name: string, nodes: TreeNodeInput[]): TreeRecord {
    // 先跑一遍树校验，保证不合法树不会落库
    analyze({ rulesText: '', nodes, limits: this.limits });
    return this.repo.createTree(name, nodes);
  }

  importRules(treeId: number, rulesText: string): {
    ruleVersion: RuleVersionRecord;
    diagnostics: Diagnostic[];
  } {
    const { diagnostics } = parseRules(rulesText, this.limits);
    if (diagnostics.length > 0) {
      throw new AnalyzerError(
        'RULE_PARSE_ERROR',
        `规则文本包含 ${diagnostics.length} 条诊断，已整体拒绝（不会静默跳过错误规则）`,
        { diagnostics },
      );
    }
    return { ruleVersion: this.repo.addRuleVersion(treeId, rulesText), diagnostics };
  }

  analyzeTree(
    treeId: number,
    ruleVersionNumber?: number,
  ): { report: AnalysisReport; reportId: number; ruleVersion: RuleVersionRecord } {
    const tree = this.requireTree(treeId);
    const ruleVersion = ruleVersionNumber
      ? this.requireRuleVersion(treeId, ruleVersionNumber)
      : this.repo.latestRuleVersion(treeId);
    if (!ruleVersion) {
      throw new AnalyzerError(
        'VERSION_NOT_FOUND',
        '该树尚无规则版本，请先导入规则',
        { treeId },
        404,
      );
    }
    const { report } = analyze({
      rulesText: ruleVersion.rulesText,
      nodes: tree.nodes,
      treeVersion: tree.id,
      ruleVersion: ruleVersion.version,
      limits: this.limits,
    });
    const saved = this.repo.saveReport(tree.id, ruleVersion.id, report);
    return { report, reportId: saved.id, ruleVersion };
  }

  explain(
    treeId: number,
    path: string,
    type: 'file' | 'dir',
    ruleVersionNumber?: number,
  ): PathExplanation {
    const tree = this.requireTree(treeId);
    const ruleVersion = ruleVersionNumber
      ? this.requireRuleVersion(treeId, ruleVersionNumber)
      : this.repo.latestRuleVersion(treeId);
    if (!ruleVersion) {
      throw new AnalyzerError('VERSION_NOT_FOUND', '该树尚无规则版本', { treeId }, 404);
    }
    return explainPath(ruleVersion.rulesText, path, type, tree.nodes, this.limits);
  }

  compare(treeId: number, versionA: number, versionB: number) {
    const tree = this.requireTree(treeId);
    const a = this.requireRuleVersion(treeId, versionA);
    const b = this.requireRuleVersion(treeId, versionB);
    return diffRuleVersions(
      tree.nodes,
      { text: a.rulesText, version: a.version },
      { text: b.rulesText, version: b.version },
      this.limits,
    );
  }

  getReport(reportId: number): ReportRecord {
    const report = this.repo.getReport(reportId);
    if (!report) {
      throw new AnalyzerError('REPORT_NOT_FOUND', '历史报告不存在', { reportId }, 404);
    }
    return report;
  }

  private requireTree(treeId: number): TreeRecord {
    const tree = this.repo.getTree(treeId);
    if (!tree) throw new AnalyzerError('TREE_NOT_FOUND', '树不存在', { treeId }, 404);
    return tree;
  }

  private requireRuleVersion(treeId: number, version: number): RuleVersionRecord {
    const rec = this.repo.getRuleVersionByVersion(treeId, version);
    if (!rec) {
      throw new AnalyzerError(
        'VERSION_NOT_FOUND',
        '规则版本不存在',
        { treeId, version },
        404,
      );
    }
    return rec;
  }
}
