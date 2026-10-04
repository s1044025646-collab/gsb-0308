import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRules, patternToRegex } from './matcher.js';

describe('patternToRegex 子集', () => {
  const matches = (pattern: string, path: string) =>
    new RegExp('^' + patternToRegex(pattern) + '$').test(path);

  it('单星号与问号不跨斜杠', () => {
    assert.equal(matches('*.log', 'a'), false);
    assert.equal(matches('*.log', 'a.log'), true);
    assert.equal(matches('*.log', 'dir/a.log'), false);
    assert.equal(matches('a?c', 'abc'), true);
    assert.equal(matches('a?c', 'a/c'), false);
  });

  it('双星号匹配零层与多层', () => {
    assert.equal(matches('a/**/b', 'a/b'), true);
    assert.equal(matches('a/**/b', 'a/x/b'), true);
    assert.equal(matches('a/**/b', 'a/x/y/b'), true);
    assert.equal(matches('a/**/b', 'b/b'), false);
    assert.equal(matches('**/foo', 'foo'), true);
    assert.equal(matches('**/foo', 'x/y/foo'), true);
    assert.equal(matches('a/**', 'a/b/c'), true);
    assert.equal(matches('a/**', 'a'), true);
    assert.equal(matches('**/*.tmp', 'zero.tmp'), true);
    assert.equal(matches('**/*.tmp', 'x/zero.tmp'), true);
  });

  it('非完整段双星号报诊断', () => {
    assert.throws(() => patternToRegex('a**/b'), /完整路径段/);
  });

  it('转义开头井号/感叹号作为字面量', () => {
    const { rules, diagnostics } = parseRules('\\#keep\n\\!secret');
    assert.equal(diagnostics.length, 0);
    assert.equal(rules.length, 2);
    assert.equal(rules[0]!.regex.test('#keep'), true);
    assert.equal(rules[1]!.regex.test('!secret'), true);
    assert.equal(rules[1]!.negated, false);
  });
});

describe('parseRules 诊断', () => {
  it('空行与井号注释被忽略', () => {
    const { rules, diagnostics } = parseRules('\n# 注释\n\n*.log\n');
    assert.equal(rules.length, 1);
    assert.equal(diagnostics.length, 0);
  });

  it('字符类不支持并报诊断', () => {
    const { diagnostics } = parseRules('foo[0-9]');
    assert.equal(diagnostics[0]?.code, 'RULE_CHARACTER_CLASS_UNSUPPORTED');
  });

  it('尾部空格不支持并报诊断', () => {
    const { diagnostics } = parseRules('foo ');
    assert.equal(diagnostics[0]?.code, 'RULE_TRAILING_SPACE_UNSUPPORTED');
  });

  it('其他反斜杠转义报诊断', () => {
    const { diagnostics } = parseRules('foo\\tbar');
    assert.equal(diagnostics[0]?.code, 'RULE_INVALID_ESCAPE');
  });

  it('空规则体（仅斜杠/仅感叹号）报诊断', () => {
    assert.equal(parseRules('/').diagnostics[0]?.code, 'RULE_EMPTY_BODY');
    assert.equal(parseRules('!').diagnostics[0]?.code, 'RULE_EMPTY_BODY');
  });
});
