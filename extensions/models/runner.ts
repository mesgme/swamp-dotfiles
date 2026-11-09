/**
 * Runs POSIX shell scripts on the machine being configured: either this one
 * (`LocalRunner`) or a remote one over the system `ssh` (`SshRunner`).
 *
 * Everything the engine does to a machine goes through `Runner.exec`, so the
 * local and remote paths share the same code. The remote machine needs only
 * sshd and `sh`; swamp does not have to be installed there.
 *
 * @module
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  /** True when the machine is not the one swamp is running on. */
  remote: boolean;
  /** Human readable name of the machine, for reports. */
  label: string;
  /** Run a shell script, optionally feeding it text on stdin. */
  exec(script: string, stdin?: string): Promise<ExecResult>;
  /** Release anything held open for the connection. */
  close?(): Promise<void>;
}

/** Quote a string so `sh` reads it back as exactly one literal word. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function spawn(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<ExecResult> {
  // swamp-quality-ignore deno-command: running sh locally and ssh remotely is the purpose of this extension; arguments are shell-quoted with shq()
  const child = new Deno.Command(cmd, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const done = child.output();
  if (stdin !== undefined) {
    try {
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(stdin));
      await w.close();
    } catch {
      // The script exited without reading stdin; its exit code says why.
    }
  }
  const out = await done;
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

export class LocalRunner implements Runner {
  remote = false;
  label = "local";
  exec(script: string, stdin?: string): Promise<ExecResult> {
    return spawn("sh", ["-c", script], stdin);
  }
}

export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  strictHostKeyChecking: "yes" | "accept-new" | "no";
}

function sshOptions(t: SshTarget, controlPath: string): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    "ControlPersist=60",
    "-o",
    `StrictHostKeyChecking=${t.strictHostKeyChecking}`,
  ];
  if (t.port) args.push("-p", String(t.port));
  if (t.identityFile) {
    args.push("-i", t.identityFile, "-o", "IdentitiesOnly=yes");
  }
  return args;
}

function destination(t: SshTarget): string {
  return t.user ? `${t.user}@${t.host}` : t.host;
}

/** Arguments for one non-interactive, multiplexed `ssh` invocation. */
export function sshArgs(
  t: SshTarget,
  controlPath: string,
  script: string,
): string[] {
  return [
    ...sshOptions(t, controlPath),
    destination(t),
    `sh -c ${shq(script)}`,
  ];
}

export class SshRunner implements Runner {
  remote = true;
  label: string;
  #dir: string;
  #control: string;

  constructor(private target: SshTarget) {
    this.label = target.user ? `${target.user}@${target.host}` : target.host;
    this.#dir = Deno.makeTempDirSync({ prefix: "dotfiles-ssh-" });
    this.#control = `${this.#dir}/cm-%C`;
  }

  exec(script: string, stdin?: string): Promise<ExecResult> {
    return spawn("ssh", sshArgs(this.target, this.#control, script), stdin);
  }

  async close(): Promise<void> {
    const args = [
      ...sshOptions(this.target, this.#control),
      "-O",
      "exit",
      destination(this.target),
    ];
    await spawn("ssh", args).catch(() => {});
    await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}
