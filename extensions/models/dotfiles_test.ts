import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { model } from "./dotfiles.ts";

async function setup(items: unknown[]) {
  const repo = await Deno.makeTempDir({ prefix: "dotfiles-model-" });
  await Deno.mkdir(join(repo, "dotfiles"));
  await Deno.writeTextFile(join(repo, "dotfiles", "rc"), "one\n");
  const written: Array<{ spec: string; name: string; data: Record<string, unknown> }> = [];
  const context = {
    repoDir: repo,
    globalArgs: { target: { kind: "local" }, sourceDir: "dotfiles", items },
    logger: { info() {} },
    writeResource(spec: string, name: string, data: Record<string, unknown>) {
      written.push({ spec, name, data });
      return Promise.resolve({ name, specName: spec });
    },
  };
  return { repo, written, context };
}

Deno.test("apply converges and reports; verify passes afterwards", async () => {
  const { repo, written, context } = await setup([]);
  // Absolute destinations inside the temp repo keep the test out of $HOME.
  context.globalArgs.items = [{ kind: "file", src: "rc", dest: join(repo, "out/rc") }];

  await model.methods.apply.execute({}, context);
  assertEquals(written.at(-1)!.name, "apply");
  assertEquals((written.at(-1)!.data.summary as Record<string, number>).created, 1);
  assertEquals(await Deno.readTextFile(join(repo, "out/rc")), "one\n");

  await model.methods.apply.execute({}, context);
  assertEquals((written.at(-1)!.data.summary as Record<string, number>).unchanged, 1);

  await model.methods.verify.execute({}, context); // must not throw
});

Deno.test("verify fails naming the drifted item, and does not repair it", async () => {
  const { repo, context } = await setup([]);
  const dest = join(repo, "out/rc");
  context.globalArgs.items = [{ kind: "file", src: "rc", dest }];
  await model.methods.apply.execute({}, context);
  await Deno.writeTextFile(dest, "tampered\n");

  const err = await assertRejects(() => model.methods.verify.execute({}, context));
  assertStringIncludes((err as Error).message, dest);
  assertEquals(await Deno.readTextFile(dest), "tampered\n");
});

Deno.test("a failed item makes apply throw but the report is still written", async () => {
  const { repo, written, context } = await setup([]);
  context.globalArgs.items = [
    { kind: "command", name: "boom", run: "exit 3", unless: "false" },
    { kind: "file", content: "x\n", dest: join(repo, "out/after") },
  ];
  const err = await assertRejects(() => model.methods.apply.execute({}, context));
  assertStringIncludes((err as Error).message, "boom");
  const report = written.at(-1)!.data;
  assertEquals(report.ok, false);
  assert((report.items as Array<{ name: string }>).some((i) => i.name === join(repo, "out/after")));
  assertEquals(await Deno.readTextFile(join(repo, "out/after")), "x\n");
});
