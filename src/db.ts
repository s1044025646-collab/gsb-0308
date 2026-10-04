import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SYNTAX_VERSION } from "./limits";
import { AnalysisResult, PathReport } from "./types";

export interface RuleVersionRow {
  id: number;
  content: string;
  syntax_version: string;
  created_at: string;
}

export interface TreeVersionRow {
  id: number;
  payload: string;
  created_at: string;
}

export interface ReportRow {
  id: number;
  tree_id: number;
  rule_version_id: number;
  syntax_version: string;
  result: string;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        syntax_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tree_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL REFERENCES tree_versions(id),
        rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
        syntax_version TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS active_refs (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tree_id INTEGER REFERENCES tree_versions(id),
        rule_version_id INTEGER REFERENCES rule_versions(id)
      );
      INSERT OR IGNORE INTO active_refs (id, tree_id, rule_version_id) VALUES (1, NULL, NULL);
    `);
  }

  insertRules(content: string): number {
    const stmt = this.db.prepare(
      "INSERT INTO rule_versions (content, syntax_version) VALUES (?, ?)"
    );
    const info = stmt.run(content, SYNTAX_VERSION);
    this.db.prepare("UPDATE active_refs SET rule_version_id = ? WHERE id = 1").run(
      Number(info.lastInsertRowid)
    );
    return Number(info.lastInsertRowid);
  }

  insertTree(payload: string): number {
    const info = this.db
      .prepare("INSERT INTO tree_versions (payload) VALUES (?)")
      .run(payload);
    this.db.prepare("UPDATE active_refs SET tree_id = ? WHERE id = 1").run(
      Number(info.lastInsertRowid)
    );
    return Number(info.lastInsertRowid);
  }

  getRules(id: number): RuleVersionRow | undefined {
    return this.db.prepare("SELECT * FROM rule_versions WHERE id = ?").get(id) as
      | RuleVersionRow
      | undefined;
  }

  getTree(id: number): TreeVersionRow | undefined {
    return this.db.prepare("SELECT * FROM tree_versions WHERE id = ?").get(id) as
      | TreeVersionRow
      | undefined;
  }

  listRules(): RuleVersionRow[] {
    return this.db
      .prepare("SELECT * FROM rule_versions ORDER BY id ASC")
      .all() as unknown as RuleVersionRow[];
  }

  listTrees(): TreeVersionRow[] {
    return this.db
      .prepare("SELECT * FROM tree_versions ORDER BY id ASC")
      .all() as unknown as TreeVersionRow[];
  }

  activeRefs(): { treeId: number | null; ruleVersionId: number | null } {
    const row = this.db.prepare("SELECT * FROM active_refs WHERE id = 1").get() as {
      tree_id: number | null;
      rule_version_id: number | null;
    };
    return { treeId: row.tree_id, ruleVersionId: row.rule_version_id };
  }

  saveReport(treeId: number, ruleVersionId: number, result: AnalysisResult): number {
    const info = this.db
      .prepare(
        "INSERT INTO reports (tree_id, rule_version_id, syntax_version, result) VALUES (?, ?, ?, ?)"
      )
      .run(treeId, ruleVersionId, SYNTAX_VERSION, JSON.stringify(result));
    return Number(info.lastInsertRowid);
  }

  getReport(id: number): (ReportRow & { parsed: AnalysisResult }) | undefined {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as unknown as
      | ReportRow
      | undefined;
    if (!row) return undefined;
    return { ...row, parsed: JSON.parse(row.result) as AnalysisResult };
  }

  listReports(): Array<{
    id: number;
    tree_id: number;
    rule_version_id: number;
    syntax_version: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT id, tree_id, rule_version_id, syntax_version, created_at FROM reports ORDER BY id ASC"
      )
      .all() as Array<{
      id: number;
      tree_id: number;
      rule_version_id: number;
      syntax_version: string;
      created_at: string;
    }>;
  }

  close(): void {
    this.db.close();
  }
}

export function buildAnalysisResult(
  reports: Map<string, PathReport>,
  ruleVersionId: number | null,
  treeId: number | null
): AnalysisResult {
  const all = [...reports.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const ignoredCount = all.filter((r) => r.ignored).length;
  return {
    syntaxVersion: SYNTAX_VERSION,
    ruleVersionId,
    treeId,
    reports: all,
    ignoredCount,
    visibleCount: all.length - ignoredCount,
  };
}
