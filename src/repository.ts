import type { DatabaseSync } from 'node:sqlite';
import { AnalyzerError } from './errors.js';
import { SUPPORTED_SYNTAX_VERSION } from './limits.js';
import type { AnalysisReport } from './types.js';
import type { TreeNodeInput } from './types.js';

export interface TreeRecord {
  id: number;
  name: string;
  nodes: TreeNodeInput[];
  nodeCount: number;
  createdAt: string;
}

export interface RuleVersionRecord {
  id: number;
  treeId: number;
  version: number;
  rulesText: string;
  syntaxVersion: string;
  createdAt: string;
}

export interface ReportRecord {
  id: number;
  treeId: number;
  ruleVersionId: number;
  report: AnalysisReport;
  ignoredCount: number;
  visibleCount: number;
  createdAt: string;
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  createTree(name: string, nodes: TreeNodeInput[]): TreeRecord {
    const stmt = this.db.prepare(
      'INSERT INTO trees (name, payload_json, node_count) VALUES (?, ?, ?)',
    );
    const info = stmt.run(name, JSON.stringify(nodes), nodes.length);
    const id = Number(info.lastInsertRowid);
    const rec = this.getTree(id);
    if (!rec) throw new AnalyzerError('TREE_NOT_FOUND', '树创建后读取失败', { id }, 500);
    return rec;
  }

  getTree(id: number): TreeRecord | null {
    const row = this.db
      .prepare('SELECT * FROM trees WHERE id = ?')
      .get(id) as
      | { id: number; name: string; payload_json: string; node_count: number; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      nodes: JSON.parse(row.payload_json) as TreeNodeInput[],
      nodeCount: row.node_count,
      createdAt: row.created_at,
    };
  }

  listTrees(): { id: number; name: string; nodeCount: number; createdAt: string }[] {
    const rows = this.db
      .prepare('SELECT id, name, node_count, created_at FROM trees ORDER BY id')
      .all() as { id: number; name: string; node_count: number; created_at: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, nodeCount: r.node_count, createdAt: r.created_at }));
  }

  addRuleVersion(treeId: number, rulesText: string): RuleVersionRecord {
    const tree = this.getTree(treeId);
    if (!tree) throw new AnalyzerError('TREE_NOT_FOUND', '树不存在', { treeId }, 404);
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM rule_versions WHERE tree_id = ?')
      .get(treeId) as { v: number };
    const version = maxRow.v + 1;
    this.db
      .prepare(
        'INSERT INTO rule_versions (tree_id, version, rules_text, syntax_version) VALUES (?, ?, ?, ?)',
      )
      .run(treeId, version, rulesText, SUPPORTED_SYNTAX_VERSION);
    const rec = this.getRuleVersionByVersion(treeId, version);
    if (!rec) throw new AnalyzerError('VERSION_NOT_FOUND', '规则版本创建后读取失败', {}, 500);
    return rec;
  }

  getRuleVersion(id: number): RuleVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM rule_versions WHERE id = ?')
      .get(id) as
      | {
          id: number;
          tree_id: number;
          version: number;
          rules_text: string;
          syntax_version: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      treeId: row.tree_id,
      version: row.version,
      rulesText: row.rules_text,
      syntaxVersion: row.syntax_version,
      createdAt: row.created_at,
    };
  }

  getRuleVersionByVersion(treeId: number, version: number): RuleVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM rule_versions WHERE tree_id = ? AND version = ?')
      .get(treeId, version) as
      | {
          id: number;
          tree_id: number;
          version: number;
          rules_text: string;
          syntax_version: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return this.getRuleVersion(row.id);
  }

  latestRuleVersion(treeId: number): RuleVersionRecord | null {
    const row = this.db
      .prepare('SELECT id FROM rule_versions WHERE tree_id = ? ORDER BY version DESC LIMIT 1')
      .get(treeId) as { id: number } | undefined;
    return row ? this.getRuleVersion(row.id) : null;
  }

  listRuleVersions(treeId: number): { id: number; version: number; createdAt: string }[] {
    const rows = this.db
      .prepare('SELECT id, version, created_at FROM rule_versions WHERE tree_id = ? ORDER BY version')
      .all(treeId) as { id: number; version: number; created_at: string }[];
    return rows.map((r) => ({ id: r.id, version: r.version, createdAt: r.created_at }));
  }

  saveReport(
    treeId: number,
    ruleVersionId: number,
    report: AnalysisReport,
  ): ReportRecord {
    const info = this.db
      .prepare(
        `INSERT INTO reports (tree_id, rule_version_id, payload_json, ignored_count, visible_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        treeId,
        ruleVersionId,
        JSON.stringify(report),
        report.stats.ignored,
        report.stats.visible,
      );
    const rec = this.getReport(Number(info.lastInsertRowid));
    if (!rec) throw new AnalyzerError('REPORT_NOT_FOUND', '报告创建后读取失败', {}, 500);
    return rec;
  }

  getReport(id: number): ReportRecord | null {
    const row = this.db
      .prepare('SELECT * FROM reports WHERE id = ?')
      .get(id) as
      | {
          id: number;
          tree_id: number;
          rule_version_id: number;
          payload_json: string;
          ignored_count: number;
          visible_count: number;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      treeId: row.tree_id,
      ruleVersionId: row.rule_version_id,
      report: JSON.parse(row.payload_json) as AnalysisReport,
      ignoredCount: row.ignored_count,
      visibleCount: row.visible_count,
      createdAt: row.created_at,
    };
  }

  listReports(treeId?: number): {
    id: number;
    treeId: number;
    ruleVersionId: number;
    ignoredCount: number;
    visibleCount: number;
    createdAt: string;
  }[] {
    const sql = treeId
      ? 'SELECT id, tree_id, rule_version_id, ignored_count, visible_count, created_at FROM reports WHERE tree_id = ? ORDER BY id'
      : 'SELECT id, tree_id, rule_version_id, ignored_count, visible_count, created_at FROM reports ORDER BY id';
    const rows = (treeId
      ? (this.db.prepare(sql).all(treeId) as unknown[])
      : (this.db.prepare(sql).all() as unknown[])) as {
      id: number;
      tree_id: number;
      rule_version_id: number;
      ignored_count: number;
      visible_count: number;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      treeId: r.tree_id,
      ruleVersionId: r.rule_version_id,
      ignoredCount: r.ignored_count,
      visibleCount: r.visible_count,
      createdAt: r.created_at,
    }));
  }
}
