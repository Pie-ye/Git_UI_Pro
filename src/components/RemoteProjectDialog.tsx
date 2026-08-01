import {
  AlertCircle,
  Check,
  ClipboardPaste,
  Copy,
  FileKey2,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Server,
  ShieldCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { GitProject, RemoteProjectInput, RemoteProjectTestResult } from "../types/domain";

interface RemoteProjectDialogProps {
  onClose: () => void;
  onChooseIdentityFile: () => Promise<string | null>;
  onTest: (input: RemoteProjectInput) => Promise<RemoteProjectTestResult>;
  onAdd: (input: RemoteProjectInput) => Promise<GitProject>;
}

type FieldName = "host" | "username" | "port" | "repositoryPath" | "identityFile";
type FormState = Record<FieldName, string>;
type ConnectionFeedback = { tone: "success" | "error"; message: string; detail?: string };

const initialForm: FormState = {
  host: "",
  username: "",
  port: "",
  repositoryPath: "",
  identityFile: ""
};

export function RemoteProjectDialog({ onClose, onChooseIdentityFile, onTest, onAdd }: RemoteProjectDialogProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [feedback, setFeedback] = useState<ConnectionFeedback | null>(null);
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"test" | "add" | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const hostInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busy = busyAction !== null;
  const errors = useMemo(() => validateForm(form), [form]);
  const input = useMemo(() => buildRemoteInput(form), [form]);
  const currentFingerprint = useMemo(() => remoteInputFingerprint(input), [input]);
  const connectionVerified = testedFingerprint === currentFingerprint;

  useEffect(() => {
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    hostInputRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        if (!dialogRef.current?.isConnected) {
          previousFocusRef.current?.focus();
        }
      });
    };
  }, []);

  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [busy, onClose]);

  function updateField(field: FieldName, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFeedback(null);
    setTestedFingerprint(null);
  }

  function markTouched(field: FieldName) {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function markAllTouched() {
    setTouched({ host: true, username: true, port: true, repositoryPath: true, identityFile: true });
  }

  function applyRemoteAddress() {
    const parsed = parseRemoteAddress(address);
    if (!parsed) {
      setAddressError("无法识别该 SSH 地址，请检查主机和仓库路径。");
      return;
    }

    setAddressError("");
    setForm((current) => ({ ...current, ...parsed, port: parsed.port || "22" }));
    setTouched((current) => ({ ...current, host: true, repositoryPath: true }));
    setFeedback(null);
    setTestedFingerprint(null);
    window.requestAnimationFrame(() => hostInputRef.current?.focus());
  }

  async function testConnection() {
    markAllTouched();
    if (Object.keys(errors).length > 0) {
      setFeedback({ tone: "error", message: "请先修正连接信息。" });
      return;
    }

    setBusyAction("test");
    setFeedback(null);
    try {
      const result = await onTest(input);
      if (result.ok) {
        setTestedFingerprint(currentFingerprint);
        setFeedback({ tone: "success", message: "连接已验证", detail: result.repositoryRoot });
      } else {
        setTestedFingerprint(null);
        setFeedback({ tone: "error", message: result.messageZh ?? "连接失败", detail: result.stderr.trim() || undefined });
      }
    } catch (error) {
      setTestedFingerprint(null);
      setFeedback(errorFeedback(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    markAllTouched();
    if (Object.keys(errors).length > 0) {
      setFeedback({ tone: "error", message: "请先修正连接信息。" });
      return;
    }

    setBusyAction("add");
    setFeedback(null);
    try {
      await onAdd(input);
    } catch (error) {
      setFeedback(errorFeedback(error));
      setBusyAction(null);
    }
  }

  async function chooseIdentityFile() {
    const filePath = await onChooseIdentityFile();
    if (filePath) {
      updateField("identityFile", filePath);
      markTouched("identityFile");
    }
  }

  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
      ) ?? []
    );
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="branch-dialog-backdrop remote-project-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        ref={dialogRef}
        className="branch-dialog remote-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-project-title"
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="branch-dialog-header remote-project-header">
          <span className="branch-dialog-title" id="remote-project-title">
            <Server size={16} />
            连接远程仓库
          </span>
          <button type="button" className="icon-button compact-icon" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={15} />
          </button>
        </header>

        <form className="remote-project-form" onSubmit={submit} noValidate>
          <div className="remote-project-scroll">
            <label className={`remote-address-field ${addressError ? "invalid" : ""}`}>
              <span>SSH 地址</span>
              <div className="remote-address-input">
                <ClipboardPaste size={15} aria-hidden="true" />
                <input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setAddressError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && address.trim()) {
                      event.preventDefault();
                      applyRemoteAddress();
                    }
                  }}
                  placeholder="git@server.example.com:/srv/projects/repository"
                  autoComplete="off"
                  disabled={busy}
                />
                <button type="button" className="remote-address-apply" title="解析并填写连接信息" aria-label="解析并填写连接信息" onClick={applyRemoteAddress} disabled={busy || !address.trim()}>
                  <Check size={14} />
                </button>
              </div>
              {addressError ? <small className="remote-field-error">{addressError}</small> : null}
            </label>

            <div className="remote-project-divider"><span>连接详情</span></div>

            <div className="remote-project-fields">
              <Field label="SSH 主机" error={touched.host ? errors.host : undefined} className="remote-host-field">
                <input
                  ref={hostInputRef}
                  value={form.host}
                  onChange={(event) => updateField("host", event.target.value)}
                  onBlur={() => markTouched("host")}
                  placeholder="server.example.com 或 SSH 别名"
                  autoComplete="off"
                  aria-invalid={Boolean(touched.host && errors.host)}
                  disabled={busy}
                />
              </Field>
              <Field label="用户名" error={touched.username ? errors.username : undefined}>
                <input
                  value={form.username}
                  onChange={(event) => updateField("username", event.target.value)}
                  onBlur={() => markTouched("username")}
                  placeholder="使用 SSH 配置"
                  autoComplete="username"
                  aria-invalid={Boolean(touched.username && errors.username)}
                  disabled={busy}
                />
              </Field>
              <Field label="端口" error={touched.port ? errors.port : undefined}>
                <input
                  value={form.port}
                  onChange={(event) => updateField("port", event.target.value.replace(/\D/g, ""))}
                  onBlur={() => markTouched("port")}
                  placeholder="22"
                  inputMode="numeric"
                  aria-invalid={Boolean(touched.port && errors.port)}
                  disabled={busy}
                />
              </Field>
              <Field label="仓库绝对路径" error={touched.repositoryPath ? errors.repositoryPath : undefined} className="remote-path-field">
                <input
                  value={form.repositoryPath}
                  onChange={(event) => updateField("repositoryPath", event.target.value)}
                  onBlur={() => markTouched("repositoryPath")}
                  placeholder="/srv/projects/my-repository"
                  autoComplete="off"
                  aria-invalid={Boolean(touched.repositoryPath && errors.repositoryPath)}
                  disabled={busy}
                />
              </Field>
              <Field label="私钥文件（可选）" error={touched.identityFile ? errors.identityFile : undefined} className="remote-key-field">
                <div className="remote-key-input">
                  <FileKey2 size={15} aria-hidden="true" />
                  <input
                    value={form.identityFile}
                    onChange={(event) => updateField("identityFile", event.target.value)}
                    onBlur={() => markTouched("identityFile")}
                    placeholder="使用 SSH Agent 或默认私钥"
                    autoComplete="off"
                    disabled={busy}
                  />
                  {form.identityFile ? (
                    <button type="button" className="icon-button compact-icon remote-key-clear" title="清除私钥文件" aria-label="清除私钥文件" onClick={() => updateField("identityFile", "")} disabled={busy}>
                      <X size={13} />
                    </button>
                  ) : null}
                  <button type="button" className="icon-button compact-icon" title="选择私钥文件" aria-label="选择私钥文件" onClick={() => void chooseIdentityFile()} disabled={busy}>
                    <FolderOpen size={15} />
                  </button>
                </div>
              </Field>
            </div>

            <div className="remote-auth-summary">
              <span className="remote-auth-icon">{form.identityFile ? <KeyRound size={15} /> : <ShieldCheck size={15} />}</span>
              <span>
                <small>认证方式</small>
                <strong>{form.identityFile ? "指定私钥" : "SSH Agent / SSH 配置"}</strong>
              </span>
              <small>不保存密码</small>
            </div>

            {feedback ? (
              <ConnectionFeedbackView feedback={feedback} />
            ) : (
              <div className="remote-connection-idle" aria-live="polite">
                <ShieldCheck size={15} />
                <span>连接测试只读取仓库信息，不会修改服务器文件。</span>
              </div>
            )}
          </div>

          <div className="branch-dialog-actions remote-project-actions">
            <span className={`remote-verification-state ${connectionVerified ? "verified" : ""}`}>
              {connectionVerified ? <Check size={13} /> : <span aria-hidden="true" />}
              {connectionVerified ? "连接已验证" : "尚未验证"}
            </span>
            <button type="button" className="text-button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="button" className="text-button remote-test-button" onClick={() => void testConnection()} disabled={busy || Object.keys(errors).length > 0}>
              {busyAction === "test" ? <LoaderCircle className="spin" size={15} /> : <Server size={15} />}
              {busyAction === "test" ? "正在测试" : connectionVerified ? "重新测试" : "测试连接"}
            </button>
            <button type="submit" className="primary-action remote-connect-button" disabled={busy || Object.keys(errors).length > 0}>
              {busyAction === "add" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {busyAction === "add" ? "正在添加" : connectionVerified ? "添加项目" : "连接并添加"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Field({ label, error, className = "", children }: { label: string; error?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`remote-project-field ${error ? "invalid" : ""} ${className}`}>
      <span>{label}</span>
      {children}
      {error ? <small className="remote-field-error">{error}</small> : null}
    </label>
  );
}

function ConnectionFeedbackView({ feedback }: { feedback: ConnectionFeedback }) {
  async function copyDetail() {
    if (feedback.detail) {
      await navigator.clipboard?.writeText(feedback.detail).catch(() => undefined);
    }
  }

  return (
    <div className={`remote-connection-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
      {feedback.tone === "success" ? <Check size={16} /> : <AlertCircle size={16} />}
      <span>
        <strong>{feedback.message}</strong>
        {feedback.detail && feedback.tone === "success" ? <small>{feedback.detail}</small> : null}
        {feedback.detail && feedback.tone === "error" ? (
          <details>
            <summary>查看原始信息</summary>
            <div>
              <pre>{feedback.detail}</pre>
              <button type="button" className="icon-button compact-icon" title="复制原始信息" aria-label="复制原始信息" onClick={() => void copyDetail()}>
                <Copy size={13} />
              </button>
            </div>
          </details>
        ) : null}
      </span>
    </div>
  );
}

function buildRemoteInput(form: FormState): RemoteProjectInput {
  return {
    host: form.host.trim(),
    username: form.username.trim() || undefined,
    port: form.port.trim() ? Number(form.port) : undefined,
    repositoryPath: form.repositoryPath.trim().replace(/\\/g, "/"),
    identityFile: form.identityFile.trim() || undefined
  };
}

function remoteInputFingerprint(input: RemoteProjectInput): string {
  return JSON.stringify([
    input.host.toLowerCase(),
    input.username ?? "",
    input.port ?? 22,
    input.repositoryPath.replace(/\/$/, ""),
    input.identityFile ?? ""
  ]);
}

function parseRemoteAddress(value: string): Partial<FormState> | null {
  const address = value.trim();
  if (!address) {
    return null;
  }

  if (/^ssh:\/\//i.test(address)) {
    try {
      const url = new URL(address);
      const repositoryPath = decodeURIComponent(url.pathname);
      if (!url.hostname || !repositoryPath.startsWith("/")) {
        return null;
      }
      return {
        host: url.hostname,
        username: decodeURIComponent(url.username),
        port: url.port,
        repositoryPath
      };
    } catch {
      return null;
    }
  }

  const scpAddress = /^(?:([^@\s:]+)@)?(\[[^\]]+\]|[^\s:]+):(\/.*)$/.exec(address);
  if (scpAddress) {
    return {
      username: scpAddress[1] ?? "",
      host: scpAddress[2].replace(/^\[|\]$/g, ""),
      repositoryPath: scpAddress[3]
    };
  }

  const destination = /^(?:([^@\s]+)@)?([^@\s]+)$/.exec(address);
  if (destination) {
    return { username: destination[1] ?? "", host: destination[2] };
  }

  return null;
}

function validateForm(form: FormState): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  const host = form.host.trim();
  const username = form.username.trim();
  const port = form.port.trim();
  const repositoryPath = form.repositoryPath.trim().replace(/\\/g, "/");
  if (!host) {
    errors.host = "请输入 SSH 主机。";
  } else if (!/^[a-z0-9._:-]+$/i.test(host) || host.startsWith("-")) {
    errors.host = "主机名或 SSH 别名格式不正确。";
  }
  if (username && !/^[a-z0-9._-]+$/i.test(username)) {
    errors.username = "用户名格式不正确。";
  }
  if (port && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    errors.port = "端口应为 1 到 65535。";
  }
  if (!repositoryPath) {
    errors.repositoryPath = "请输入远程仓库路径。";
  } else if (!repositoryPath.startsWith("/")) {
    errors.repositoryPath = "请输入服务器上的绝对路径。";
  }
  return errors;
}

function errorFeedback(error: unknown): ConnectionFeedback {
  const raw = error instanceof Error ? error.message : "连接失败。";
  const clean = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim();
  const [message, ...details] = clean.split(/\r?\n/).filter(Boolean);
  return { tone: "error", message: message || "连接失败。", detail: details.join("\n") || undefined };
}
