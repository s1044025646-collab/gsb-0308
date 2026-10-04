import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDatabase } from './db.js';
import { AnalyzerService } from './service.js';
import type { TreeNodeInput } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'gia-test-'));
const dbFile = join(dir, 'test.db');
const nodes: TreeNodeInput[] = [
  { path: 'build', type: 'dir' },
  { path: 'build/keep.txt', type: 'file' },
  { path: 'logs', type: 'dir' },
  { path: 'logs/a.log', type: 'file' },
];

after(() => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const end = Date.now() + 100;
      while (Date.now() < end) {
        // busy wait for Windows file handle release
      }
    }
  }
});

describe('持久化与重启后旧报告完整可读', () => {
  it('导入树、两版规则并各自生成报告', () => {
    const db = openDatabase(dbFile);
    const svc = new AnalyzerService(db);
    const tree = svc.importTree('demo', nodes);
    svc.importRules(tree.id, 'build/\n*.log');
    const r1 = svc.analyzeTree(tree.id);
    assert.equal(r1.report.explanations['build/keep.txt']!.ignored, true);

    svc.importRules(tree.id, 'build/\n!build/');
    const r2 = svc.analyzeTree(tree.id);
    assert.equal(r2.report.ruleVersion, 2);
    assert.equal(r2.report.explanations['build/keep.txt']!.ignored, false);
    assert.ok(r1.reportId !== r2.reportId);
    db.close();
  });

  it('错误规则被整体拒绝，不产生新版本', () => {
    const db = openDatabase(dbFile);
    const svc = new AnalyzerService(db);
    assert.throws(
      () => svc.importRules(1, 'foo[1]\n*.log'),
      /整体拒绝/,
    );
    db.close();
  });

  it('重新打开数据库后，旧报告不变（删规则不影响历史报告）', () => {
    const db = openDatabase(dbFile);
    const svc = new AnalyzerService(db);
    const old = svc.getReport(1);
    assert.equal(old.report.explanations['build/keep.txt']!.ignored, true);
    assert.equal(old.report.explanations['logs/a.log']!.ignored, true);
    assert.equal(old.report.stats.ignored, 3);
    const versions = svc.repo.listRuleVersions(1);
    // 被拒绝的规则没有生成版本
    assert.equal(versions.length, 2);
    db.close();
  });
});
