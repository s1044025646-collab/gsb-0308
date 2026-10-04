import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze, diffRuleVersions, explainPath } from './analyze.js';
import type { TreeNodeInput } from './types.js';

const tree: TreeNodeInput[] = [
  { path: 'logs', type: 'dir' },
  { path: 'logs/a.log', type: 'file' },
  { path: 'logs/keep.log', type: 'file' },
  { path: 'build', type: 'dir' },
  { path: 'build/out.o', type: 'file' },
  { path: 'build/keep.txt', type: 'file' },
  { path: 'rootonly.log', type: 'file' },
  { path: 'src', type: 'dir' },
  { path: 'src/rootonly.log', type: 'file' },
  { path: 'a', type: 'dir' },
  { path: 'a/b', type: 'dir' },
  { path: 'a/b/deep.tmp', type: 'file' },
  { path: 'zero.tmp', type: 'file' },
  // 文件与目录同名（不同路径层级/身份）
  { path: 'notes', type: 'file' },
  { path: 'data', type: 'dir' },
  { path: 'data/notes', type: 'dir' },
];

function exOf(rules: string, path: string, nodes = tree) {
  return analyze({ rulesText: rules, nodes }).report.explanations[path]!;
}

describe('演示场景：日志整体忽略 + 单文件取反', () => {
  const rules = '*.log\n!logs/keep.log';
  it('logs/a.log 被忽略', () => assert.equal(exOf(rules, 'logs/a.log').ignored, true));
  it('logs/keep.log 因后出现的取反恢复', () => {
    const ex = exOf(rules, 'logs/keep.log');
    assert.equal(ex.ignored, false);
    assert.equal(ex.decisiveRule?.line, 2);
    assert.equal(ex.decisiveRule?.effect, 'negation');
  });
});

describe('根锚定 vs 任意层名字匹配', () => {
  const rules = '/rootonly.log\n*.tmp\n*.log';
  it('/rootonly.log 忽略根，不忽略深层同名', () => {
    assert.equal(exOf(rules, 'rootonly.log').ignored, true);
    // 深层同名不被锚定规则命中，但会被任意层的 *.log 命中（与 git check-ignore 一致）
    const ex = exOf(rules, 'src/rootonly.log');
    assert.equal(ex.ignored, true);
    assert.equal(ex.directMatches[0]?.raw, '*.log');
  });
  it('*.tmp 任意层名字匹配', () => {
    assert.equal(exOf(rules, 'zero.tmp').ignored, true);
    assert.equal(exOf(rules, 'a/b/deep.tmp').ignored, true);
  });
});

describe('双星号匹配零层', () => {
  const rules = '**/*.tmp';
  it('zero.tmp 与 a/b/deep.tmp 都被忽略', () => {
    assert.equal(exOf(rules, 'zero.tmp').ignored, true);
    assert.equal(exOf(rules, 'a/b/deep.tmp').ignored, true);
  });
});

describe('build/ 剪枝：取反子文件无法越过被排除父目录', () => {
  const rules = 'build/\n!build/keep.txt';
  it('build 目录被忽略', () => {
    assert.equal(exOf(rules, 'build').ignored, true);
  });
  it('build/keep.txt 直接命中取反但遍历仍不可见，阻断链指向 build', () => {
    const ex = exOf(rules, 'build/keep.txt');
    assert.equal(ex.directIgnored, false);
    assert.equal(ex.visible, false);
    assert.equal(ex.blockerChain[0]?.dirPath, 'build');
    assert.equal(ex.blockerChain[0]?.rule.line, 1);
    assert.equal(ex.decisiveRule?.line, 1);
  });

  it('加入 !build/ 恢复父目录后，子文件取反生效', () => {
    const rules2 = 'build/\n!build/\n!build/keep.txt';
    const ex = exOf(rules2, 'build/keep.txt');
    assert.equal(ex.visible, true);
    assert.equal(ex.blockerChain.length, 0);
    assert.equal(ex.decisiveRule?.line, 3);
    const out = exOf(rules2, 'build/out.o');
    assert.equal(out.ignored, false);
  });
});

describe('顺序颠倒', () => {
  it('先取反后忽略：忽略规则在后，最终被忽略', () => {
    const rules = '!logs/keep.log\n*.log';
    const ex = exOf(rules, 'logs/keep.log');
    assert.equal(ex.ignored, true);
    assert.equal(ex.decisiveRule?.line, 2);
  });
});

describe('目录专用模式（结尾斜杠）不匹配文件', () => {
  it('notes 是文件时不被 notes/ 命中，data/notes 目录被命中', () => {
    const rules = 'notes/';
    assert.equal(exOf(rules, 'notes').ignored, false);
    assert.equal(exOf(rules, 'data/notes').ignored, true);
  });
});

describe('文件与目录同名', () => {
  const small: TreeNodeInput[] = [
    { path: 'x', type: 'file' },
    { path: 'x2', type: 'dir' },
  ];
  it('名字模式同时作用于文件和目录', () => {
    const { report } = analyze({
      rulesText: 'x',
      nodes: [
        { path: 'x', type: 'file' },
        { path: 'y', type: 'dir' },
        { path: 'y/x', type: 'file' },
      ],
    });
    assert.equal(report.explanations['x']!.ignored, true);
    assert.equal(report.explanations['y/x']!.ignored, true);
  });
  void small;
});

describe('直接匹配与遍历结果的差别', () => {
  it('取反文件直接匹配为“不忽略”，遍历却被父目录剪枝', () => {
    const standalone = explainPath('build/\n!build/keep.txt', 'build/keep.txt', 'file');
    assert.equal(standalone.directIgnored, false);
    assert.equal(standalone.ignored, false);
    const inTree = exOf('build/\n!build/keep.txt', 'build/keep.txt');
    assert.equal(inTree.directIgnored, false);
    assert.equal(inTree.ignored, true);
  });
});

describe('输入节点重排不变性', () => {
  it('打乱节点顺序后结果一致', () => {
    const rules = '*.log\nbuild/\n!logs/keep.log';
    const a = analyze({ rulesText: rules, nodes: tree }).report;
    const shuffled = [...tree].reverse();
    const b = analyze({ rulesText: rules, nodes: shuffled }).report;
    assert.deepEqual(
      a.rows.map((r) => [r.path, r.ignored, r.blockerPath]),
      b.rows.map((r) => [r.path, r.ignored, r.blockerPath]),
    );
  });
});

describe('版本比较', () => {
  it('新增取反规则后 keep.log 可见性变化', () => {
    const diff = diffRuleVersions(
      tree,
      { text: '*.log', version: 1 },
      { text: '*.log\n!logs/keep.log', version: 2 },
    );
    const changed = diff.changedPaths.find((c) => c.path === 'logs/keep.log');
    assert.ok(changed);
    assert.equal(changed!.ignoredA, true);
    assert.equal(changed!.ignoredB, false);
    assert.deepEqual(diff.addedLines, [2]);
  });
});
