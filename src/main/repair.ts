import { app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SETUP_CALL } from "../shared/ipc";
import type { ProfilesResult } from "../shared/ipc";
import { applicationPaths } from "./applicationPaths";

const EXIT_CODE_CANCELLED = 1223;
const EXIT_CODE_LAUNCH_FAILED = 1224;

const repairSupported = process.platform === "win32" || process.platform === "linux";

export function daemonBinaryPath(): string {
  const binaryName =
    process.platform === "win32" ? "sing-box-daemon.exe" : "sing-box-daemon";
  if (app.isPackaged) {
    return join(process.resourcesPath, "daemon", binaryName);
  }
  return join(app.getAppPath(), "bin", binaryName);
}

function windowsPowerShellPath(): string {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function runDaemonBinary(
  commandArguments: string[],
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      daemonBinaryPath(),
      commandArguments,
      { timeout: 10000, windowsHide: true },
      (error, stdout) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error === null ? 0 : (error.code as number), stdout });
      },
    );
  });
}

let cachedBundledVersion: Promise<string | null> | null = null;

export function bundledDaemonVersion(): Promise<string | null> {
  cachedBundledVersion ??= (async () => {
    try {
      const result = await runDaemonBinary(["version"]);
      if (result.exitCode !== 0) {
        return null;
      }
      const versionLine = result.stdout
        .split("\n")
        .find((line) => line.startsWith("sing-box-daemon version "));
      return versionLine?.slice("sing-box-daemon version ".length).trim() || null;
    } catch {
      return null;
    }
  })();
  return cachedBundledVersion;
}

export type ServiceProbeResult = "not-installed" | "not-running" | "running" | null;

export async function probeService(): Promise<ServiceProbeResult> {
  if (!repairSupported) {
    return null;
  }
  try {
    const result = await runDaemonBinary(["service", "status"]);
    switch (result.exitCode) {
      case 0:
        return "running";
      case 2:
        return "not-running";
      case 3:
        return "not-installed";
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsCommandLineQuote(value: string): string {
  if (value !== "" && !/[\s"]/u.test(value)) {
    return value;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

const PKEXEC_EXIT_CODE_CANCELLED = 126;

function runElevatedLinux(commandArguments: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "pkexec",
      [daemonBinaryPath(), ...commandArguments],
      { timeout: 120000 },
      (error, _stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          if (error.code === "ENOENT") {
            resolve(EXIT_CODE_LAUNCH_FAILED);
            return;
          }
          reject(error);
          return;
        }
        if (error === null) {
          resolve(0);
          return;
        }
        const exitCode = error.code as number;
        if (exitCode === PKEXEC_EXIT_CODE_CANCELLED) {
          resolve(EXIT_CODE_CANCELLED);
          return;
        }
        const message = stderr
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line !== "");
        if (message !== undefined) {
          reject(new Error(message));
          return;
        }
        resolve(exitCode);
      },
    );
  });
}

function windowsInstallIsPortable(): boolean {
  const daemon = daemonBinaryPath().toLowerCase();
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase().replace(/[/\\]+$/u, ""));
  return !roots.some((root) => daemon.startsWith(`${root}\\`) || daemon.startsWith(`${root}/`));
}

function execPowerShellEncoded(encodedCommand: string, hideWindow = false): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      windowsPowerShellPath(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      { timeout: 120000, windowsHide: hideWindow },
      (error) => {
        if (error && typeof error.code !== "number") {
          if (error.code === "ENOENT") {
            resolve(EXIT_CODE_LAUNCH_FAILED);
            return;
          }
          reject(error);
          return;
        }
        resolve(error === null ? 0 : (error.code as number));
      },
    );
  });
}

function formatWindowsServiceError(exitCode: number, logText: string): string {
  const log = logText.replace(/\s+/gu, " ").trim();
  if (exitCode === EXIT_CODE_CANCELLED) {
    return "已取消管理员权限。安装系统服务必须点「是」。";
  }
  if (exitCode === EXIT_CODE_LAUNCH_FAILED) {
    return [
      "无法弹出管理员权限窗口。",
      "请右键 AngelaBox.exe → 属性 → 若有「解除锁定」请勾选，",
      "关掉对 PowerShell / 未知程序的拦截后再点安装。",
    ].join("");
  }
  if (/unprivileged principal|unsafe installation|replaceable by an unprivileged/iu.test(log)) {
    return "便携目录不在 Program Files，系统拒绝把服务装到可被普通用户改写的位置。请改用安装器，或把压缩包解压到本地 NTFS 磁盘后再安装。";
  }
  if (/Authenticode|signing certificate|WinVerifyTrust/iu.test(log)) {
    return "签名校验失败。不要改动解压出来的文件，重新下载完整压缩包。";
  }
  if (/not installed on NTFS|fixed local drive/iu.test(log)) {
    return "请解压到本机 NTFS 磁盘，不要放在 U 盘、网络盘或 exFAT 分区。";
  }
  if (log !== "") {
    return `服务安装失败（退出码 ${exitCode}）：${log.slice(0, 500)}`;
  }
  return `服务安装失败，退出码 ${exitCode}。请允许管理员权限后重试。`;
}

async function runElevatedWindows(commandArguments: string[]): Promise<{
  exitCode: number;
  logText: string;
}> {
  const powershell = windowsPowerShellPath();
  const daemon = daemonBinaryPath();
  const argumentList = commandArguments.map(windowsCommandLineQuote).join(" ");
  const workDirectory = await mkdtemp(join(tmpdir(), "angelabox-elevate-"));
  const helperPath = join(workDirectory, "run.ps1");
  const logPath = join(workDirectory, "run.log");
  const helper = [
    "$ErrorActionPreference = 'Continue'",
    `$log = ${powerShellQuote(logPath)}`,
    "function Log($m) { Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }",
    "try {",
    `  Get-ChildItem -LiteralPath ${powerShellQuote(dirname(daemon))} -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue`,
    `  Get-ChildItem -LiteralPath ${powerShellQuote(join(dirname(daemon), "..", ".."))} -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue`,
    `  $process = Start-Process -FilePath ${powerShellQuote(daemon)} -ArgumentList ${powerShellQuote(argumentList)} -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput ${powerShellQuote(join(workDirectory, "stdout.txt"))} -RedirectStandardError ${powerShellQuote(join(workDirectory, "stderr.txt"))}`,
    "  $stdout = ''",
    "  $stderr = ''",
    `  if (Test-Path -LiteralPath ${powerShellQuote(join(workDirectory, "stdout.txt"))}) { $stdout = Get-Content -LiteralPath ${powerShellQuote(join(workDirectory, "stdout.txt"))} -Raw -ErrorAction SilentlyContinue }`,
    `  if (Test-Path -LiteralPath ${powerShellQuote(join(workDirectory, "stderr.txt"))}) { $stderr = Get-Content -LiteralPath ${powerShellQuote(join(workDirectory, "stderr.txt"))} -Raw -ErrorAction SilentlyContinue }`,
    "  if ($stdout) { Log $stdout.TrimEnd() }",
    "  if ($stderr) { Log $stderr.TrimEnd() }",
    "  if ($null -eq $process) { Log 'daemon process did not start'; exit " + String(EXIT_CODE_LAUNCH_FAILED) + " }",
    "  Log ('daemon exit ' + $process.ExitCode)",
    "  exit $process.ExitCode",
    "} catch {",
    "  Log $_.Exception.ToString()",
    "  exit " + String(EXIT_CODE_LAUNCH_FAILED),
    "}",
    "",
  ].join("\n");
  await writeFile(helperPath, helper, "utf8");
  const launcher = [
    "try {",
    `$helper = ${powerShellQuote(helperPath)}`,
    `$p = Start-Process -FilePath ${powerShellQuote(powershell)} -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$helper) -Verb RunAs -Wait -PassThru`,
    "if ($null -eq $p) { exit " + String(EXIT_CODE_LAUNCH_FAILED) + " }",
    "exit $p.ExitCode",
    "} catch {",
    "$exception = $_.Exception",
    "while ($null -ne $exception) {",
    "if ($exception -is [System.ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) {",
    `exit ${EXIT_CODE_CANCELLED}`,
    "}",
    "$exception = $exception.InnerException",
    "}",
    `exit ${EXIT_CODE_LAUNCH_FAILED}`,
    "}",
  ].join("\n");
  const encoded = Buffer.from(launcher, "utf16le").toString("base64");
  try {
    const exitCode = await execPowerShellEncoded(encoded);
    const logText = await readFile(logPath, "utf8").catch(() => "");
    return { exitCode, logText };
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runElevatedServiceCommand(
  commandArguments: string[],
): Promise<boolean> {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("elevated service commands are not supported on this platform");
  }
  if (process.platform === "linux") {
    const exitCode = await runElevatedLinux(commandArguments);
    if (exitCode === 0) {
      return true;
    }
    if (exitCode === EXIT_CODE_CANCELLED) {
      return false;
    }
    if (exitCode === EXIT_CODE_LAUNCH_FAILED) {
      throw new Error("failed to launch the elevated service command");
    }
    throw new Error(`service command failed with exit code ${exitCode}`);
  }
  const { exitCode, logText } = await runElevatedWindows(commandArguments);
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === EXIT_CODE_CANCELLED) {
    return false;
  }
  throw new Error(formatWindowsServiceError(exitCode, logText));
}

async function unblockPortableFiles(): Promise<void> {
  const root = join(dirname(daemonBinaryPath()), "..", "..");
  const script = `Get-ChildItem -LiteralPath ${powerShellQuote(root)} -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue; exit 0`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await execPowerShellEncoded(encoded, true).catch(() => 0);
}

async function repair(action: "install" | "start", onRepaired: () => void): Promise<boolean> {
  if (!repairSupported) {
    throw new Error("service repair is not supported on this platform");
  }
  if (process.platform === "win32") {
    await unblockPortableFiles();
  }
  const serviceAction = process.platform === "linux" && action === "install" ? "restart" : action;
  const commandArguments = ["service", serviceAction];
  if (process.platform === "win32" && action === "install") {
    commandArguments.push("--working-directory", applicationPaths().daemonData);
    if (windowsInstallIsPortable()) {
      commandArguments.push("--allow-unsafe-installation-directory-permissions");
    }
  }
  if (process.platform === "linux") {
    const exitCode = await runElevatedLinux(commandArguments);
    if (exitCode === 0) {
      onRepaired();
      return true;
    }
    if (exitCode === EXIT_CODE_CANCELLED) {
      return false;
    }
    if (exitCode === EXIT_CODE_LAUNCH_FAILED) {
      throw new Error("failed to launch the elevated service command");
    }
    throw new Error(`service ${serviceAction} failed with exit code ${exitCode}`);
  }
  const { exitCode, logText } = await runElevatedWindows(commandArguments);
  if (exitCode === 0) {
    onRepaired();
    return true;
  }
  if (exitCode === EXIT_CODE_CANCELLED) {
    return false;
  }
  throw new Error(formatWindowsServiceError(exitCode, logText));
}

export function registerSetup(onRepaired: () => void) {
  const handlers: Record<string, () => Promise<unknown>> = {
    repairInstall: () => repair("install", onRepaired),
    repairStart: () => repair("start", onRepaired),
  };
  ipcMain.handle(SETUP_CALL, async (_event, method: string): Promise<ProfilesResult> => {
    const handler = handlers[method];
    if (!handler) {
      return { ok: false, error: `unknown setup method: ${method}` };
    }
    try {
      const value = await handler();
      return { ok: true, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Command failed:")) {
        return { ok: false, error: formatWindowsServiceError(EXIT_CODE_LAUNCH_FAILED, message) };
      }
      return { ok: false, error: message };
    }
  });
}
