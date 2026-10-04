import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validatePath, validateTree } from './tree.js';

describe('validatePath', () => {
  it('拒绝绝对路径与盘符', () => {
    assert.throws(() => validatePath('/a/b'), /绝对路径/);
    assert.throws(() => validatePath('C:/a'), /绝对路径/);
  });
  it('拒绝反斜杠、空段、点段', () => {
    assert.throws(() => validatePath('a\\b'), /正斜杠/);
    assert.throws(() => validatePath('a//b'), /空段/);
    assert.throws(() => validatePath('a/./b'), /\.\s*或\s*\.\./);
    assert.throws(() => validatePath('a/../b'), /\.\s*或\s*\.\./);
  });
  it('合法路径返回分段', () => {
    assert.deepEqual(validatePath('a/b/c.ts'), ['a', 'b', 'c.ts']);
  });
});

describe('validateTree', () => {
  it('拒绝重复条目', () => {
    assert.throws(
      () =>
        validateTree([
          { path: 'a', type: 'file' },
          { path: 'a', type: 'file' },
        ]),
      /重复/,
    );
  });
  it('拒绝文件充当目录父节点', () => {
    assert.throws(
      () =>
        validateTree([
          { path: 'a', type: 'file' },
          { path: 'a/b', type: 'file' },
        ]),
      /文件不能充当目录/,
    );
  });
  it('显式文件/目录身份被接受，缺省父目录允许（虚拟树无需列出全部中间目录？此处仍要求显式）', () => {
    // 本实现允许省略中间目录：只有“文件充当父节点”才拒绝
    const nodes = validateTree([
      { path: 'src/a.ts', type: 'file' },
      { path: 'src', type: 'dir' },
    ]);
    assert.equal(nodes.length, 2);
  });
});
