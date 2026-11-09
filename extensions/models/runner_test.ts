import { assert, assertEquals } from "jsr:@std/assert@1";
import { LocalRunner, shq, sshArgs } from "./runner.ts";

Deno.test("shq survives a round trip through sh, including quotes and newlines", async () => {
  for (const s of ["plain", "it's", 'a "b" $HOME `x`', "line1\nline2", ""]) {
    const out = await new LocalRunner().exec(`printf %s ${shq(s)}`);
    assertEquals(out.stdout, s);
  }
});

Deno.test("LocalRunner passes stdin and reports exit codes and stderr", async () => {
  const r = await new LocalRunner().exec("cat; echo err >&2; exit 4", "from stdin");
  assertEquals(r, { code: 4, stdout: "from stdin", stderr: "err\n" });
});

Deno.test("sshArgs builds a non-interactive, multiplexed ssh command", () => {
  const args = sshArgs(
    { host: "box.example", user: "mark", port: 2222, identityFile: "/k/id", strictHostKeyChecking: "accept-new" },
    "/tmp/cp-%C",
    "echo 'hi'",
  );
  assertEquals(args[args.indexOf("-p") + 1], "2222");
  assertEquals(args[args.indexOf("-i") + 1], "/k/id");
  assert(args.includes("BatchMode=yes"));
  assert(args.includes("ControlPath=/tmp/cp-%C"));
  assert(args.includes("StrictHostKeyChecking=accept-new"));
  assertEquals(args.at(-2), "mark@box.example");
  assert(args.at(-1)!.startsWith("sh -c '"));
  assert(args.at(-1)!.includes(`echo '\\''hi'\\''`));
});

Deno.test("sshArgs omits user and optional flags when not given", () => {
  const args = sshArgs({ host: "h", strictHostKeyChecking: "accept-new" }, "/tmp/c", "true");
  assertEquals(args.at(-2), "h");
  assert(!args.includes("-p"));
  assert(!args.includes("-i"));
});
