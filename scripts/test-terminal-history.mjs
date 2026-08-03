import assert from "node:assert/strict";
import test from "node:test";
import terminalHistoryModule from "../dist-electron/terminalHistory.js";

const {
  TRUSTED_PROMPT_MARKER,
  canReplayTerminalHistory,
  captureTerminalInput,
  createTerminalCaptureState,
  observeTerminalOutput
} = terminalHistoryModule;

test("SSH Shell 提示符确认后记录用户提交的命令", () => {
  let state = createTerminalCaptureState();
  state = observeTerminalOutput(state, "deploy@example.com:/srv/repo$ ", false);
  assert.equal(canReplayTerminalHistory(state), true);

  let capture = captureTerminalInput(state, "git status");
  capture = captureTerminalInput(capture.state, "\r");
  assert.equal(capture.command, "git status");
  assert.equal(canReplayTerminalHistory(capture.state), false);
});

test("密码和验证码提示后的输入不会进入命令历史", () => {
  let state = observeTerminalOutput(createTerminalCaptureState(), "root@server:/opt/app# ", false);
  let capture = captureTerminalInput(state, "sudo systemctl restart app\r");
  assert.equal(capture.command, "sudo systemctl restart app");

  state = observeTerminalOutput(capture.state, "[sudo] password for root: ", false);
  assert.equal(state.sensitiveInput, true);
  capture = captureTerminalInput(state, "not-a-real-password\r");
  assert.equal(capture.command, undefined);

  state = observeTerminalOutput(capture.state, "Verification code: ", false);
  capture = captureTerminalInput(state, "123456\r");
  assert.equal(capture.command, undefined);
});

test("无法确认 Shell 边界或使用未知编辑序列时不记录输入", () => {
  let capture = captureTerminalInput(createTerminalCaptureState(), "git status\r");
  assert.equal(capture.command, undefined);

  let state = observeTerminalOutput(createTerminalCaptureState(), "custom prompt > ", false);
  capture = captureTerminalInput(state, "pwd\r");
  assert.equal(capture.command, undefined);

  state = observeTerminalOutput(createTerminalCaptureState(), "user@host:~$ ", false);
  capture = captureTerminalInput(state, "\u001b[A\r");
  assert.equal(capture.command, undefined);
});

test("本地可信 OSC 提示标记继续支持命令记录", () => {
  const state = observeTerminalOutput(createTerminalCaptureState(), `${TRUSTED_PROMPT_MARKER}PS E:\\repo> `, true);
  const capture = captureTerminalInput(state, "npm test\r");
  assert.equal(capture.command, "npm test");
});
