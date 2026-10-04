import { analyze } from './analyze.js';
import type { TreeNodeInput } from './types.js';

export interface DemoScenario {
  name: string;
  description: string;
  rules: string;
  tree: TreeNodeInput[];
  focusPaths: string[];
}

/** 题目要求覆盖的五个核心场景，合并为一棵共享演示树并分别给规则。 */
const sharedTree: TreeNodeInput[] = [
  { path: 'src', type: 'dir' },
  { path: 'src/app.ts', type: 'file' },
  { path: 'logs', type: 'dir' },
  { path: 'logs/a.log', type: 'file' },
  { path: 'logs/keep.log', type: 'file' },
  { path: 'build', type: 'dir' },
  { path: 'build/out.o', type: 'file' },
  { path: 'build/keep.txt', type: 'file' },
  { path: 'a', type: 'dir' },
  { path: 'a/b', type: 'dir' },
  { path: 'a/b/c', type: 'dir' },
  { path: 'a/b/c/deep.tmp', type: 'file' },
  { path: 'zero.tmp', type: 'file' },
  { path: 'rootonly.log', type: 'file' },
  { path: 'src/rootonly.log', type: 'file' },
  { path: 'README', type: 'file' },
  { path: 'notes', type: 'file' },
  { path: 'data', type: 'dir' },
  { path: 'data/notes', type: 'dir' },
];

export const demoScenarios: DemoScenario[] = [
  {
    name: '01 忽略全部日志后重新包含一个文件',
    description: '*.log 命中所有日志；!logs/keep.log 在后，直接取反使其恢复可见。',
    rules: ['*.log', '!logs/keep.log'].join('\n'),
    tree: sharedTree,
    focusPaths: ['logs/a.log', 'logs/keep.log', 'rootonly.log'],
  },
  {
    name: '02 根目录限定 vs 任意层名字匹配',
    description:
      '/rootonly.log 只锚定根（src/rootonly.log 不命中）；*.tmp 无斜杠可在任意层按名字匹配。',
    rules: ['/rootonly.log', '*.tmp'].join('\n'),
    tree: sharedTree,
    focusPaths: ['rootonly.log', 'src/rootonly.log', 'a/b/c/deep.tmp'],
  },
  {
    name: '03 双星号匹配零层',
    rules: ['**/*.tmp'].join('\n'),
    description: 'a/**/deep.tmp 同时匹配 a/deep.tmp（零层）与 a/b/c/deep.tmp（多层）。',
    tree: sharedTree,
    focusPaths: ['zero.tmp', 'a/b/c/deep.tmp'],
  },
  {
    name: '04 build/ 被忽略后单独取反子文件仍无法生效',
    description:
      'build/ 是目录专用模式，build 被剪枝；!build/keep.txt 虽直接命中文件，但无法越过被排除的父目录。',
    rules: ['build/', '!build/keep.txt'].join('\n'),
    tree: sharedTree,
    focusPaths: ['build', 'build/keep.txt', 'build/out.o'],
  },
  {
    name: '05 恢复父目录后子文件取反生效',
    description: '加入 !build/ 先把目录重新包含，遍历得以进入；!build/keep.txt 才能让文件恢复。',
    rules: ['build/', '!build/', '!build/keep.txt'].join('\n'),
    tree: sharedTree,
    focusPaths: ['build', 'build/keep.txt', 'build/out.o'],
  },
];

export function runDemo(): string {
  const lines: string[] = [];
  lines.push('================ Gitignore 规则分析演示 ================');

  for (const scenario of demoScenarios) {
    lines.push('');
    lines.push('--------------------------------------------------------');
    lines.push(scenario.name);
    lines.push(scenario.description);
    lines.push('规则原文:');
    for (const [i, r] of scenario.rules.split(/\r?\n/).entries()) {
      lines.push(`  L${i + 1}: ${r}`);
    }
    const { report } = analyze({ rulesText: scenario.rules, nodes: scenario.tree });
    lines.push('');
    lines.push('关注路径结果（ignored / 决定性行号 / 首个阻断目录 / 直接命中是否忽略）:');
    for (const focus of scenario.focusPaths) {
      const ex = report.explanations[focus]!;
      const hitLines = ex.directMatches.map((h) => `L${h.line}(${h.effect === 'negation' ? '取反' : '正向'})`).join(', ') || '无';
      lines.push(
        `  ${focus.padEnd(22)} ignored=${String(ex.ignored).padEnd(6)} ` +
          `directIgnored=${String(ex.directIgnored).padEnd(6)} ` +
          `decisive=${ex.decisiveRule ? 'L' + ex.decisiveRule.line : '无'} ` +
          `blocker=${ex.blockerChain[0]?.dirPath ?? '无'} ` +
          `直接命中=[${hitLines}]`,
      );
    }
    lines.push(
      `统计: 总节点 ${report.stats.total}，忽略 ${report.stats.ignored}，可见 ${report.stats.visible}，被剪枝子树 ${report.stats.prunedSubtrees}`,
    );
  }

  lines.push('');
  lines.push('================ 演示结束 ================');
  return lines.join('\n');
}
