export const TRUSTED_PROMPT_MARKER = "\u001b]633;A\u0007";

export interface TerminalCaptureState {
  buffer: string;
  reliable: boolean;
  commandBoundaryConfirmed: boolean;
  sensitiveInput: boolean;
  outputTail: string;
  markerTail: string;
}

export interface TerminalInputCapture {
  state: TerminalCaptureState;
  command?: string;
}

const SENSITIVE_PROMPT_PATTERN = /(?:password|passphrase|password for|pin|otp|one[- ]time(?: password| code)?|verification code|密码|口令|验证码|认证码)\s*(?:for\s+[^:：]*)?[:：]?\s*$/iu;
const UNIX_SHELL_PROMPT_PATTERN = /^(?:\([^\r\n)]{1,40}\)\s*)?[\w.-]+@[\w.-]+(?::[^\r\n]{0,180})?[#$%]\s*$/u;
const POWERSHELL_PROMPT_PATTERN = /^PS\s+(?:[A-Za-z]:\\|\/)[^\r\n>]{0,220}>\s*$/iu;
const COMMAND_PROMPT_PATTERN = /^[A-Za-z]:\\[^\r\n>]{0,220}>\s*$/u;

export function createTerminalCaptureState(): TerminalCaptureState {
  return {
    buffer: "",
    reliable: true,
    commandBoundaryConfirmed: false,
    sensitiveInput: false,
    outputTail: "",
    markerTail: ""
  };
}

export function observeTerminalOutput(
  state: TerminalCaptureState,
  data: string,
  trustedPromptMarkers: boolean
): TerminalCaptureState {
  const markerSource = state.markerTail + data;
  const hasTrustedMarker = trustedPromptMarkers && markerSource.includes(TRUSTED_PROMPT_MARKER);
  const outputTail = `${state.outputTail}${stripTerminalSequences(data)}`.slice(-512);
  const currentLine = outputTail.split(/[\r\n]/u).at(-1)?.trimEnd() ?? "";
  const sensitiveInput = SENSITIVE_PROMPT_PATTERN.test(currentLine);
  const inferredShellPrompt = isRecognizedShellPrompt(currentLine);

  return {
    ...state,
    buffer: hasTrustedMarker || inferredShellPrompt || sensitiveInput ? "" : state.buffer,
    reliable: hasTrustedMarker || inferredShellPrompt || sensitiveInput ? true : state.reliable,
    commandBoundaryConfirmed: sensitiveInput ? false : hasTrustedMarker || inferredShellPrompt || state.commandBoundaryConfirmed,
    sensitiveInput,
    outputTail,
    markerTail: markerSource.slice(-(TRUSTED_PROMPT_MARKER.length - 1))
  };
}

export function captureTerminalInput(state: TerminalCaptureState, data: string): TerminalInputCapture {
  const hasSubmissionBoundary = /[\r\n]/u.test(data);
  if (state.sensitiveInput) {
    return {
      state: hasSubmissionBoundary
        ? { ...state, buffer: "", reliable: true, commandBoundaryConfirmed: false, sensitiveInput: false }
        : state
    };
  }

  if (!state.commandBoundaryConfirmed) {
    return {
      state: hasSubmissionBoundary ? { ...state, buffer: "", reliable: true } : state
    };
  }

  const consumed = consumeTerminalInput(state.buffer, state.reliable, data);
  return {
    state: {
      ...state,
      buffer: hasSubmissionBoundary ? "" : consumed.buffer,
      reliable: hasSubmissionBoundary ? true : consumed.reliable,
      commandBoundaryConfirmed: hasSubmissionBoundary ? false : state.commandBoundaryConfirmed
    },
    command: consumed.commands[0]
  };
}

export function canReplayTerminalHistory(state: TerminalCaptureState): boolean {
  return state.commandBoundaryConfirmed && !state.sensitiveInput;
}

function isRecognizedShellPrompt(line: string): boolean {
  return UNIX_SHELL_PROMPT_PATTERN.test(line) || POWERSHELL_PROMPT_PATTERN.test(line) || COMMAND_PROMPT_PATTERN.test(line);
}

function stripTerminalSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[()][0-2A-Z]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/gu, "");
}

function consumeTerminalInput(buffer: string, reliable: boolean, data: string): { buffer: string; commands: string[]; reliable: boolean } {
  const commands: string[] = [];
  let nextBuffer = buffer;
  let nextReliable = reliable;
  let index = 0;
  const normalizedData = data.replace(/\u001b\[20[01]~/gu, "");

  while (index < normalizedData.length) {
    const character = normalizedData[index];
    if (character === "\u001b") {
      const sequence = normalizedData.slice(index).match(/^\u001b(?:\[[0-?]*[ -/]*[@-~]|.)/u)?.[0];
      nextReliable = false;
      index += sequence?.length ?? 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (nextReliable && nextBuffer.trim()) commands.push(nextBuffer);
      nextBuffer = "";
      nextReliable = true;
      if (character === "\r" && normalizedData[index + 1] === "\n") index += 1;
      index += 1;
      continue;
    }
    if (character === "\u007f" || character === "\b") {
      nextBuffer = removeLastCharacter(nextBuffer);
      index += 1;
      continue;
    }
    if (character === "\u0003" || character === "\u0015") {
      nextBuffer = "";
      nextReliable = true;
      index += 1;
      continue;
    }
    if (character === "\u0017") {
      nextBuffer = nextBuffer.replace(/\s*\S+\s*$/u, "");
      index += 1;
      continue;
    }
    if (character === "\t" || character < " ") {
      nextReliable = false;
      index += 1;
      continue;
    }
    const codePoint = normalizedData.codePointAt(index);
    if (codePoint === undefined) break;
    nextBuffer += String.fromCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }

  return { buffer: nextBuffer, commands, reliable: nextReliable };
}

function removeLastCharacter(value: string): string {
  const characters = Array.from(value);
  characters.pop();
  return characters.join("");
}
