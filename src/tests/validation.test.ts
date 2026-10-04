import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRules } from "../rules";
import { validateTree } from "../tree";
import { ValidationError } from "../errors";

function expectIssues(fn: () => unknown, ...codes: string[]) {
  try {
    fn();
    assert.fail("应当抛出 ValidationError");
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    const got = err.issues.map((i) => i.code);
    for (const code of codes) assert.ok(got.includes(code), `期望诊断 ${code}，实际 ${got}`);
  }
}

test("拒绝字符类", () => {
  expectIssues(() => compileRules("foo[ab]r\n"), "UNSUPPORTED_CHARACTER_CLASS");
});

test("拒绝非法反斜杠转义", () => {
  expectIssues(() => compileRules("foo\\ bar\n"), "UNSUPPORTED_ESCAPE");
});

test("拒绝尾部空格", () => {
  expectIssues(() => compileRules("foo \n"), "UNSUPPORTED_TRAILING_WHITESPACE");
});

test("拒绝段内双星号", () => {
  expectIssues(() => compileRules("a**b\n"), "UNSUPPORTED_INFIX_DOUBLE_STAR");
});

test("嵌套 .gitignore 语义不支持：规则中出现路径仅按相对根处理，不做特殊兼容", () => {
  // 含斜杠的模式锚定根；这里确认它不会被当成嵌套 gitignore
  const rules = compileRules("sub/foo\n");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].anchored, true);
});

test("非法规则不会静默通过：多条问题一次报告", () => {
  expectIssues(() => compileRules("foo[ab]\nbar \n"), "UNSUPPORTED_CHARACTER_CLASS", "UNSUPPORTED_TRAILING_WHITESPACE");
});

test("树：拒绝绝对路径与盘符", () => {
  expectIssues(() => validateTree([{ path: "/abs", type: "file" }]), "ABSOLUTE_PATH_REJECTED");
  expectIssues(() => validateTree([{ path: "C:\\x", type: "file" }]), "BACKSLASH_UNSUPPORTED");
});

test("树：拒绝空段、点段", () => {
  expectIssues(() => validateTree([{ path: "a//b", type: "file" }]), "EMPTY_PATH_SEGMENT");
  expectIssues(() => validateTree([{ path: "a/../b", type: "file" }]), "DOT_SEGMENT_REJECTED");
});

test("树：拒绝重复条目", () => {
  expectIssues(
    () =>
      validateTree([
        { path: "a", type: "file" },
        { path: "a", type: "file" },
      ]),
    "DUPLICATE_ENTRY"
  );
});

test("树：文件不能充当目录父节点", () => {
  expectIssues(
    () =>
      validateTree([
        { path: "a", type: "file" },
        { path: "a/b", type: "file" },
      ]),
    "FILE_AS_DIRECTORY_PARENT"
  );
});

test("树：父目录缺失报错", () => {
  expectIssues(() => validateTree([{ path: "a/b/c.ts", type: "file" }]), "MISSING_PARENT");
});

test("树：节点类型必须显式", () => {
  expectIssues(() => validateTree([{ path: "a" }]), "INVALID_NODE_TYPE");
});
