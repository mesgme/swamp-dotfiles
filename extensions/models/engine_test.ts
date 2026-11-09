import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  expandPath,
  type Facts,
  makeCtx,
  parseItems,
  render,
  runItems,
} from "./engine.ts";
import { type ExecResult, LocalRunner, type Runner } from "./runner.ts";

interface Fixture {
  home: string;
  src: string;
  facts: Facts;
  run: (
    items: unknown[],
    mode: "plan" | "apply",
    opts?: { runner?: Runner; facts?: Partial<Facts>; vars?: Record<string, string> },
  ) => ReturnType<typeof runItems>;
}

async function fixture(files: Record<string, string> = {}): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "dotfiles-test-" });
  const home = join(root, "home");
  const src = join(root, "src");
  await Deno.mkdir(home);
  await Deno.mkdir(src);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(src, rel);
    await Deno.mkdir(join(p, ".."), { recursive: true });
    await Deno.writeTextFile(p, content);
  }
  const facts: Facts = { os: "linux", home, uid: 1000, user: "tester" };
  return {
    home,
    src,
    facts,
    run: (items, mode, opts = {}) =>
      runItems(
        parseItems(items),
        makeCtx(
          opts.runner ?? new LocalRunner(),
          { ...facts, ...opts.facts },
          src,
          opts.vars ?? {},
        ),
        mode,
      ),
  };
}

/** A runner that records commands and answers from a table of regexes. */
function fakeRunner(
  answers: Array<[RegExp, Partial<ExecResult>]>,
): Runner & { commands: string[] } {
  const commands: string[] = [];
  return {
    remote: false,
    label: "fake",
    commands,
    exec(script) {
      commands.push(script);
      for (const [re, res] of answers) {
        if (re.test(script)) return Promise.resolve({ code: 0, stdout: "", stderr: "", ...res });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
}

Deno.test("render substitutes variables and rejects unknown ones", () => {
  assertEquals(render("a {{ home }} b {{os}}", { home: "/h", os: "linux" }), "a /h b linux");
  try {
    render("{{nope}}", {});
    throw new Error("should have thrown");
  } catch (e) {
    assertStringIncludes((e as Error).message, "nope");
  }
});

Deno.test("expandPath handles ~, {{home}} and rejects relative paths", () => {
  assertEquals(expandPath("~/.zshrc", "/h", {}), "/h/.zshrc");
  assertEquals(expandPath("{{home}}/x", "/h", {}), "/h/x");
  assertEquals(expandPath("~", "/h", {}), "/h");
  try {
    expandPath("relative/path", "/h", {});
    throw new Error("should have thrown");
  } catch (e) {
    assertStringIncludes((e as Error).message, "absolute");
  }
});

Deno.test("file copy converges: plan, apply, plan; edits are backed up", async () => {
  const f = await fixture({ "a.txt": "one\n" });
  const items = [{ kind: "file", src: "a.txt", dest: "~/out/a.txt" }];
  const dest = join(f.home, "out/a.txt");

  assertEquals((await f.run(items, "plan")).items[0].status, "would-create");
  await assertRejects(() => Deno.stat(dest)); // plan must not touch the machine

  assertEquals((await f.run(items, "apply")).items[0].status, "created");
  assertEquals(await Deno.readTextFile(dest), "one\n");
  assertEquals((await f.run(items, "plan")).items[0].status, "unchanged");

  await Deno.writeTextFile(dest, "tampered\n");
  assertEquals((await f.run(items, "plan")).items[0].status, "would-update");
  assertEquals((await f.run(items, "apply")).items[0].status, "updated");
  assertEquals(await Deno.readTextFile(dest), "one\n");
  assertEquals(await Deno.readTextFile(dest + ".bak"), "tampered\n");

  const again = await f.run(items, "apply");
  assertEquals(again.items[0].status, "unchanged");
  assertEquals(again.ok, true);
});

Deno.test("file mode is applied and drift in mode alone is detected without a backup", async () => {
  const f = await fixture();
  const items = [{ kind: "file", content: "secret\n", dest: "~/.token", mode: "0600" }];
  const dest = join(f.home, ".token");
  await f.run(items, "apply");
  assertEquals((await Deno.stat(dest)).mode! & 0o777, 0o600);

  await Deno.chmod(dest, 0o644);
  assertEquals((await f.run(items, "plan")).items[0].status, "would-update");
  await f.run(items, "apply");
  assertEquals((await Deno.stat(dest)).mode! & 0o777, 0o600);
  await assertRejects(() => Deno.stat(dest + ".bak"));
});

Deno.test("link method symlinks to the source and backs up a regular file in the way", async () => {
  const f = await fixture({ "rc": "x\n" });
  const dest = join(f.home, ".rc");
  await Deno.writeTextFile(dest, "old\n");
  const items = [{ kind: "file", src: "rc", dest: "~/.rc", method: "link" }];

  assertEquals((await f.run(items, "apply")).items[0].status, "updated");
  assertEquals(await Deno.readLink(dest), join(f.src, "rc"));
  assertEquals(await Deno.readTextFile(dest + ".bak"), "old\n");
  assertEquals((await f.run(items, "plan")).items[0].status, "unchanged");
});

Deno.test("link falls back to a copy on a remote runner", async () => {
  const f = await fixture({ "rc": "x\n" });
  const runner = Object.assign(new LocalRunner(), { remote: true });
  const items = [{ kind: "file", src: "rc", dest: "~/.rc", method: "link" }];
  await f.run(items, "apply", { runner });
  const st = await Deno.lstat(join(f.home, ".rc"));
  assert(!st.isSymlink);
  assertEquals(await Deno.readTextFile(join(f.home, ".rc")), "x\n");
});

Deno.test("template items render variables; plain items keep braces untouched", async () => {
  const f = await fixture({ "t": "home={{home}} who={{who}}\n", "p": "keep {{home}}\n" });
  await f.run(
    [
      { kind: "file", src: "t", dest: "~/t", template: true },
      { kind: "file", src: "p", dest: "~/p" },
    ],
    "apply",
    { vars: { who: "mark" } },
  );
  assertEquals(await Deno.readTextFile(join(f.home, "t")), `home=${f.home} who=mark\n`);
  assertEquals(await Deno.readTextFile(join(f.home, "p")), "keep {{home}}\n");
});

Deno.test("an executable source stays executable when copied", async () => {
  const f = await fixture({ "bin/tool": "#!/bin/sh\n" });
  await Deno.chmod(join(f.src, "bin/tool"), 0o755);
  await f.run([{ kind: "file", src: "bin/tool", dest: "~/bin/tool" }], "apply");
  assertEquals((await Deno.stat(join(f.home, "bin/tool"))).mode! & 0o777, 0o755);
});

Deno.test("tree maps every source file, honouring exclude patterns", async () => {
  const f = await fixture({
    "skills/a/SKILL.md": "a\n",
    "skills/a/scripts/run.py": "print(1)\n",
    "skills/a/tests/test_run.py": "t\n",
    "skills/b/SKILL.md": "b\n",
  });
  const items = [{
    kind: "tree",
    src: "skills",
    dest: "~/.claude/skills",
    exclude: ["**/tests/**"],
  }];
  const plan = await f.run(items, "plan");
  assertEquals(plan.items.length, 3);
  await f.run(items, "apply");
  assertEquals(await Deno.readTextFile(join(f.home, ".claude/skills/a/scripts/run.py")), "print(1)\n");
  await assertRejects(() => Deno.stat(join(f.home, ".claude/skills/a/tests/test_run.py")));
});

Deno.test("items restricted to another OS are skipped", async () => {
  const f = await fixture();
  const items = [{ kind: "file", content: "x", dest: "~/mac-only", os: ["darwin"] }];
  const r = await f.run(items, "apply");
  assertEquals(r.items[0].status, "skipped");
  await assertRejects(() => Deno.stat(join(f.home, "mac-only")));
});

Deno.test("command runs only while its guard fails", async () => {
  const f = await fixture();
  const marker = join(f.home, "marker");
  const items = [{
    kind: "command",
    run: `echo hi > '${marker}'`,
    unless: `test -f '${marker}'`,
  }];
  assertEquals((await f.run(items, "plan")).items[0].status, "would-create");
  assertEquals((await f.run(items, "apply")).items[0].status, "created");
  assertEquals((await f.run(items, "apply")).items[0].status, "unchanged");
});

Deno.test("a failing item is reported by name, later items still run, ok is false", async () => {
  const f = await fixture();
  const items = [
    { kind: "command", name: "boom", run: "echo nope >&2; exit 3", unless: "false" },
    { kind: "file", content: "x", dest: "~/after" },
  ];
  const r = await f.run(items, "apply");
  assertEquals(r.items[0].status, "failed");
  assertStringIncludes(r.items[0].detail, "nope");
  assertEquals(r.items[1].status, "created");
  assertEquals(r.ok, false);
  assertEquals(r.summary.failed, 1);
});

Deno.test("packages use brew on darwin and apt on linux, installing only when missing", async () => {
  const f = await fixture();
  const items = [{ kind: "package", package: "tmux" }];

  const mac = fakeRunner([[/brew list/, { code: 1 }]]);
  const r1 = await f.run(items, "apply", { runner: mac, facts: { os: "darwin" } });
  assertEquals(r1.items[0].status, "created");
  assert(mac.commands.some((c) => /brew install\b.*tmux/.test(c)));

  const linux = fakeRunner([[/dpkg -s/, { code: 1 }]]);
  const r2 = await f.run(items, "apply", { runner: linux });
  assertEquals(r2.items[0].status, "created");
  assert(linux.commands.some((c) => /apt-get install -y.*tmux/.test(c)));
  assert(linux.commands.some((c) => c.includes("sudo -n")), "non-root uses sudo");

  const installed = fakeRunner([]);
  const r3 = await f.run(items, "apply", { runner: installed });
  assertEquals(r3.items[0].status, "unchanged");
  assert(!installed.commands.some((c) => c.includes("apt-get install")));
});

Deno.test("package name can differ per manager", async () => {
  const f = await fixture();
  const linux = fakeRunner([[/dpkg -s/, { code: 1 }]]);
  await f.run([{ kind: "package", package: "fd", apt: "fd-find" }], "apply", { runner: linux });
  assert(linux.commands.some((c) => c.includes("fd-find")));
});

Deno.test("gitClone clones when missing and leaves an existing checkout alone", async () => {
  const f = await fixture();
  const origin = join(f.home, "..", "origin");
  const sh = async (cmd: string, cwd?: string) => {
    const r = await new Deno.Command("sh", { args: ["-c", cmd], cwd }).output();
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
  };
  await Deno.mkdir(origin);
  await sh(
    "git init -q . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init",
    origin,
  );
  const items = [{ kind: "gitClone", repo: origin, dest: "~/.config/nvim" }];
  assertEquals((await f.run(items, "plan")).items[0].status, "would-create");
  assertEquals((await f.run(items, "apply")).items[0].status, "created");
  await Deno.stat(join(f.home, ".config/nvim/.git"));
  assertEquals((await f.run(items, "apply")).items[0].status, "unchanged");
});

Deno.test("owner/name shorthand expands to a GitHub URL", async () => {
  const f = await fixture();
  const r = fakeRunner([[/test -d/, { code: 1 }]]);
  await f.run([{ kind: "gitClone", repo: "mesgme/nvim", dest: "~/.config/nvim" }], "apply", {
    runner: r,
  });
  assert(r.commands.some((c) => c.includes("https://github.com/mesgme/nvim.git")));
});

Deno.test("invalid items are rejected when parsed", () => {
  for (
    const bad of [
      { kind: "file", dest: "~/x" }, // neither src nor content
      { kind: "file", src: "a", content: "b", dest: "~/x" }, // both
      { kind: "file", content: "b", dest: "~/x", method: "link" }, // link needs src
      { kind: "command", run: "true" }, // no guard
    ]
  ) {
    try {
      parseItems([bad]);
      throw new Error(`accepted ${JSON.stringify(bad)}`);
    } catch (e) {
      assert(!(e as Error).message.startsWith("accepted"), (e as Error).message);
    }
  }
});
