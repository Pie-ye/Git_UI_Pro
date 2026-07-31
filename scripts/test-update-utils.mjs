import assert from "node:assert/strict";
import test from "node:test";
import updateUtils from "../dist-electron/updateUtils.js";

const { githubReleaseUrl, normalizeReleaseNotes, updateErrorMessage } = updateUtils;

test("统一字符串与多版本发布说明格式", () => {
  assert.equal(normalizeReleaseNotes("  第一项\r\n第二项  "), "第一项\n第二项");
  assert.equal(
    normalizeReleaseNotes([
      { version: "0.1.13", note: "修复更新流程" },
      { version: "v0.1.12", note: "完善发布控制台" }
    ]),
    "v0.1.13\n修复更新流程\n\nv0.1.12\n完善发布控制台"
  );
});

test("更新错误信息有可读兜底且限制长度", () => {
  assert.equal(updateErrorMessage(new Error("网络不可用")), "网络不可用");
  assert.equal(updateErrorMessage(""), "检查更新失败");
  assert.equal(updateErrorMessage("x".repeat(800)).length, 600);
});

test("生成公开 GitHub Release 地址", () => {
  assert.equal(
    githubReleaseUrl("v0.1.13"),
    "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/tag/v0.1.13"
  );
});
