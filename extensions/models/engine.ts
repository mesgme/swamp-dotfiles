/**
 * The declarative engine behind the dotfiles model: parse a list of items,
 * then bring a machine to that state (`apply`) or report what would change
 * (`plan`). It only talks to the machine through a `Runner`, so it works the
 * same locally and over ssh. Every item is idempotent: a second apply reports
 * `unchanged`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  dirname,
  globToRegExp,
  isAbsolute,
  join,
  resolve,
} from "jsr:@std/path@1.0.8";
import { type Runner, shq } from "./runner.ts";

export interface Facts {
  os: "darwin" | "linux";
  home: string;
  uid: number;
  user: string;
}

const OsList = z.array(z.enum(["darwin", "linux"])).optional()
  .describe("Only apply on these operating systems");

const FileSchema = z.strictObject({
  kind: z.literal("file"),
  os: OsList,
  dest: z.string().describe("Absolute destination; ~ and {{vars}} allowed"),
  src: z.string().optional().describe("Source file, relative to sourceDir"),
  content: z.string().optional().describe("Literal content instead of src"),
  mode: z.string().regex(/^[0-7]{3,4}$/).optional().describe(
    "Octal mode, e.g. 0600. Defaults to 0755 for executable sources",
  ),
  method: z.enum(["copy", "link"]).default("copy").describe(
    "link symlinks to src; it falls back to copy on remote machines",
  ),
  template: z.boolean().default(false).describe(
    "Replace {{home}}, {{os}}, {{user}} and your vars in the content",
  ),
  backup: z.boolean().default(true).describe(
    "Keep the previous file as <dest>.bak before replacing it",
  ),
}).refine((f) => (f.src === undefined) !== (f.content === undefined), {
  message: "a file needs exactly one of src or content",
}).refine((f) => f.method !== "link" || f.src !== undefined, {
  message: "method link needs a src",
});

const TreeSchema = z.strictObject({
  kind: z.literal("tree"),
  os: OsList,
  src: z.string().describe("Directory, relative to sourceDir"),
  dest: z.string().describe("Destination directory"),
  exclude: z.array(z.string()).default([]).describe(
    "Glob patterns, relative to src, of files to leave out",
  ),
  method: z.enum(["copy", "link"]).default("copy"),
  template: z.boolean().default(false),
});

const PackageSchema = z.strictObject({
  kind: z.literal("package"),
  os: OsList,
  package: z.string().describe("Package name"),
  brew: z.string().optional().describe("Homebrew name if different"),
  apt: z.string().optional().describe("apt name if different"),
});

const GitCloneSchema = z.strictObject({
  kind: z.literal("gitClone"),
  os: OsList,
  repo: z.string().describe("owner/name for GitHub, or any git URL"),
  dest: z.string(),
});

const CommandSchema = z.strictObject({
  kind: z.literal("command"),
  os: OsList,
  name: z.string().optional(),
  run: z.string().describe("Shell command to run"),
  unless: z.string().describe(
    "Guard: run only while this exits non-zero, which keeps the item idempotent",
  ),
});

export const ItemSchema = z.discriminatedUnion("kind", [
  FileSchema,
  TreeSchema,
  PackageSchema,
  GitCloneSchema,
  CommandSchema,
]);

export type Item = z.infer<typeof ItemSchema>;
type FileItem = z.infer<typeof FileSchema>;
type TreeItem = z.infer<typeof TreeSchema>;

export function parseItems(items: unknown[]): Item[] {
  return z.array(ItemSchema).parse(items);
}

export type Status =
  | "unchanged"
  | "created"
  | "updated"
  | "would-create"
  | "would-update"
  | "skipped"
  | "failed";

export interface ItemResult {
  name: string;
  kind: string;
  status: Status;
  detail: string;
}

export interface RunResult {
  ok: boolean;
  items: ItemResult[];
  summary: Record<Status, number>;
}

export interface Ctx {
  runner: Runner;
  facts: Facts;
  srcDir: string;
  vars: Record<string, string>;
  state: { aptUpdated: boolean };
}

export function makeCtx(
  runner: Runner,
  facts: Facts,
  srcDir: string,
  vars: Record<string, string> = {},
): Ctx {
  return { runner, facts, srcDir, vars, state: { aptUpdated: false } };
}

/** Substitute `{{name}}` placeholders; an unknown name is an error. */
export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`unknown template variable "${name}"`);
    return vars[name];
  });
}

/** Expand `~` and `{{vars}}` in a destination, which must end up absolute. */
export function expandPath(
  p: string,
  home: string,
  vars: Record<string, string>,
): string {
  let out = p;
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = home + out.slice(1);
  out = render(out, { home, ...vars });
  if (!out.startsWith("/")) {
    throw new Error(`destination must be an absolute path, got "${p}"`);
  }
  return out;
}

export async function gatherFacts(runner: Runner): Promise<Facts> {
  const r = await runner.exec(
    `uname -s; printf '%s\\n' "$HOME"; id -u; id -un`,
  );
  if (r.code !== 0) {
    throw new Error(
      `cannot reach ${runner.label}: ${r.stderr.trim() || r.code}`,
    );
  }
  const [uname, home, uid, user] = r.stdout.trim().split("\n");
  const os = uname === "Darwin" ? "darwin" : uname === "Linux" ? "linux" : null;
  if (!os) throw new Error(`unsupported operating system "${uname}"`);
  if (!home) throw new Error(`${runner.label} has no $HOME`);
  return { os, home, uid: Number(uid), user };
}

type Mode = "plan" | "apply";
interface Outcome {
  status: Status;
  detail: string;
  name?: string;
}

const tplVars = (ctx: Ctx): Record<string, string> => ({
  home: ctx.facts.home,
  os: ctx.facts.os,
  user: ctx.facts.user,
  ...ctx.vars,
});

const tail = (s: string): string => s.trim().split("\n").slice(-4).join(" / ");

function changed(mode: Mode, existed: boolean): Status {
  if (mode === "plan") return existed ? "would-update" : "would-create";
  return existed ? "updated" : "created";
}

interface RemoteFile {
  kind: "none" | "other" | "link" | "file";
  target: string;
  mode: string;
  content: string;
}

async function readState(ctx: Ctx, path: string): Promise<RemoteFile> {
  const p = shq(path);
  const r = await ctx.runner.exec(
    `P=${p}
if [ -L "$P" ]; then echo link; readlink "$P"
elif [ -f "$P" ]; then echo file; { stat -c %a "$P" 2>/dev/null || stat -f %Lp "$P"; }; cat "$P"
elif [ -e "$P" ]; then echo other
else echo none; fi`,
  );
  if (r.code !== 0) throw new Error(`cannot read ${path}: ${tail(r.stderr)}`);
  const nl = r.stdout.indexOf("\n");
  const kind = r.stdout.slice(0, nl) as RemoteFile["kind"];
  const rest = r.stdout.slice(nl + 1);
  if (kind === "link") {
    return { kind, target: rest.replace(/\n$/, ""), mode: "", content: "" };
  }
  if (kind === "file") {
    const nl2 = rest.indexOf("\n");
    return {
      kind,
      target: "",
      mode: rest.slice(0, nl2),
      content: rest.slice(nl2 + 1),
    };
  }
  return { kind, target: "", mode: "", content: "" };
}

const sameMode = (a: string, b: string) => parseInt(a, 8) === parseInt(b, 8);

async function doFile(it: FileItem, ctx: Ctx, mode: Mode): Promise<Outcome> {
  const vars = tplVars(ctx);
  const dest = expandPath(it.dest, ctx.facts.home, vars);
  let content: string;
  let srcPath: string | undefined;
  let srcExec = false;
  if (it.src !== undefined) {
    srcPath = isAbsolute(it.src) ? it.src : join(ctx.srcDir, it.src);
    content = await Deno.readTextFile(srcPath);
    srcExec = (((await Deno.stat(srcPath)).mode ?? 0) & 0o111) !== 0;
  } else {
    content = it.content!;
  }
  if (it.template) content = render(content, vars);
  const wantMode = it.mode ?? (srcExec ? "0755" : undefined);
  const st = await readState(ctx, dest);
  if (st.kind === "other") {
    throw new Error(`${dest} exists and is not a file`);
  }

  if (it.method === "link" && !ctx.runner.remote) {
    const target = resolve(srcPath!);
    if (st.kind === "link" && st.target === target) {
      return { name: dest, status: "unchanged", detail: "linked" };
    }
    const status = changed(mode, st.kind !== "none");
    if (mode === "apply") {
      const r = await ctx.runner.exec(
        `set -e
P=${shq(dest)}
mkdir -p "$(dirname "$P")"
if [ -e "$P" ] && [ ! -L "$P" ]; then mv -f "$P" "$P.bak"; fi
ln -sfn ${shq(target)} "$P"`,
      );
      if (r.code !== 0) throw new Error(tail(r.stderr));
    }
    return {
      name: dest,
      status,
      detail: st.kind === "file"
        ? `linked, old file kept at ${dest}.bak`
        : "linked",
    };
  }

  if (st.kind === "file") {
    const sameContent = st.content === content;
    const modeOk = !wantMode || sameMode(st.mode, wantMode);
    if (sameContent && modeOk) {
      return { name: dest, status: "unchanged", detail: "" };
    }
    if (sameContent) {
      if (mode === "apply") {
        const r = await ctx.runner.exec(`chmod ${wantMode} ${shq(dest)}`);
        if (r.code !== 0) throw new Error(tail(r.stderr));
      }
      return {
        name: dest,
        status: changed(mode, true),
        detail: `mode ${wantMode}`,
      };
    }
  }

  const status = changed(mode, st.kind !== "none");
  if (mode === "apply") {
    const keepMode = wantMode ?? (st.kind === "file" ? st.mode : undefined);
    const backup = it.backup
      ? `if [ -f "$P" ] && [ ! -L "$P" ]; then cp -p "$P" "$P.bak"; fi`
      : "";
    const r = await ctx.runner.exec(
      `set -e
P=${shq(dest)}
mkdir -p "$(dirname "$P")"
T="$P.swamp-tmp.$$"
trap 'rm -f "$T"' EXIT
cat > "$T"
${keepMode ? `chmod ${keepMode} "$T"` : ""}
${backup}
mv -f "$T" "$P"`,
      content,
    );
    if (r.code !== 0) throw new Error(tail(r.stderr));
  }
  const kept = st.kind === "file" && it.backup
    ? `, old file kept at ${dest}.bak`
    : "";
  return { name: dest, status, detail: `written${kept}` };
}

async function expandTree(it: TreeItem, ctx: Ctx): Promise<FileItem[]> {
  const root = isAbsolute(it.src) ? it.src : join(ctx.srcDir, it.src);
  const excludes = it.exclude.map((g) =>
    globToRegExp(g, { extended: true, globstar: true })
  );
  const rels: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(join(dir, e.name), r);
      else if (!excludes.some((re) => re.test(r))) rels.push(r);
    }
  };
  await walk(root, "");
  return rels.sort().map((rel) =>
    FileSchema.parse({
      kind: "file",
      src: join(it.src, rel),
      dest: `${it.dest}/${rel}`,
      method: it.method,
      template: it.template,
      os: it.os,
    })
  );
}

async function doPackage(
  it: z.infer<typeof PackageSchema>,
  ctx: Ctx,
  mode: Mode,
): Promise<Outcome> {
  let check: string;
  let install: string;
  let name: string;
  if (ctx.facts.os === "darwin") {
    name = it.brew ?? it.package;
    const pre = `export PATH=/opt/homebrew/bin:/usr/local/bin:"$PATH"; `;
    check = `${pre}brew list --formula ${
      shq(name)
    } >/dev/null 2>&1 || brew list --cask ${shq(name)} >/dev/null 2>&1`;
    install = `${pre}brew install ${shq(name)}`;
  } else {
    name = it.apt ?? it.package;
    const sudo = ctx.facts.uid === 0 ? "" : "sudo -n ";
    check = `dpkg -s ${
      shq(name)
    } 2>/dev/null | grep -q '^Status: install ok installed'`;
    install = `export DEBIAN_FRONTEND=noninteractive; ${
      ctx.state.aptUpdated ? "" : `${sudo}apt-get update -qq && `
    }${sudo}apt-get install -y ${shq(name)}`;
  }
  if ((await ctx.runner.exec(check)).code === 0) {
    return { status: "unchanged", detail: "installed" };
  }
  if (mode === "plan") {
    return { status: "would-create", detail: `install ${name}` };
  }
  const r = await ctx.runner.exec(install);
  if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout));
  ctx.state.aptUpdated = true;
  return { status: "created", detail: `installed ${name}` };
}

async function doGitClone(
  it: z.infer<typeof GitCloneSchema>,
  ctx: Ctx,
  mode: Mode,
): Promise<Outcome> {
  const dest = expandPath(it.dest, ctx.facts.home, tplVars(ctx));
  if ((await ctx.runner.exec(`test -d ${shq(dest + "/.git")}`)).code === 0) {
    return { name: dest, status: "unchanged", detail: "already cloned" };
  }
  if (mode === "plan") {
    return { name: dest, status: "would-create", detail: `clone ${it.repo}` };
  }
  const url = /^[\w.-]+\/[\w.-]+$/.test(it.repo)
    ? `https://github.com/${it.repo}.git`
    : it.repo;
  const r = await ctx.runner.exec(
    `mkdir -p ${shq(dirname(dest))} && GIT_TERMINAL_PROMPT=0 git clone ${
      shq(url)
    } ${shq(dest)}`,
  );
  if (r.code !== 0) throw new Error(tail(r.stderr));
  return { name: dest, status: "created", detail: `cloned ${url}` };
}

async function doCommand(
  it: z.infer<typeof CommandSchema>,
  ctx: Ctx,
  mode: Mode,
): Promise<Outcome> {
  if ((await ctx.runner.exec(it.unless)).code === 0) {
    return { status: "unchanged", detail: "guard satisfied" };
  }
  if (mode === "plan") return { status: "would-create", detail: "would run" };
  const r = await ctx.runner.exec(it.run);
  if (r.code !== 0) {
    throw new Error(tail(r.stderr || r.stdout) || `exit ${r.code}`);
  }
  return { status: "created", detail: "ran" };
}

function itemName(it: Item): string {
  switch (it.kind) {
    case "package":
      return it.package;
    case "gitClone":
    case "file":
    case "tree":
      return it.dest;
    case "command":
      return it.name ?? it.run.slice(0, 40);
  }
}

async function runOne(
  it: Exclude<Item, TreeItem>,
  ctx: Ctx,
  mode: Mode,
): Promise<ItemResult> {
  const base = { name: itemName(it), kind: it.kind };
  try {
    const o = it.kind === "file"
      ? await doFile(it, ctx, mode)
      : it.kind === "package"
      ? await doPackage(it, ctx, mode)
      : it.kind === "gitClone"
      ? await doGitClone(it, ctx, mode)
      : await doCommand(it, ctx, mode);
    return {
      ...base,
      name: o.name ?? base.name,
      status: o.status,
      detail: o.detail,
    };
  } catch (e) {
    return { ...base, status: "failed", detail: (e as Error).message };
  }
}

/**
 * Run every item in order. A failing item is reported by name and the rest
 * still run; `ok` is false if any failed.
 */
export async function runItems(
  items: Item[],
  ctx: Ctx,
  mode: Mode,
): Promise<RunResult> {
  const results: ItemResult[] = [];
  for (const it of items) {
    if (it.os && !it.os.includes(ctx.facts.os)) {
      results.push({
        name: itemName(it),
        kind: it.kind,
        status: "skipped",
        detail: `only on ${it.os.join(", ")}`,
      });
      continue;
    }
    try {
      if (it.kind === "tree") {
        for (const f of await expandTree(it, ctx)) {
          results.push(await runOne(f, ctx, mode));
        }
      } else {
        results.push(await runOne(it, ctx, mode));
      }
    } catch (e) {
      results.push({
        name: itemName(it),
        kind: it.kind,
        status: "failed",
        detail: (e as Error).message,
      });
    }
  }
  const summary: Record<Status, number> = {
    unchanged: 0,
    created: 0,
    updated: 0,
    "would-create": 0,
    "would-update": 0,
    skipped: 0,
    failed: 0,
  };
  for (const r of results) summary[r.status]++;
  return { ok: summary.failed === 0, items: results, summary };
}
