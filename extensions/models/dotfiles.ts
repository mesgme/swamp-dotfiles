/**
 * Bring a machine, this one or a remote one over ssh, to a declared
 * dotfiles state: files, directory trees, packages, git clones and guarded
 * commands. `plan` shows what would change, `apply` makes it so (and a second
 * `apply` changes nothing), `verify` fails if the machine has drifted.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { isAbsolute, join } from "jsr:@std/path@1.0.8";
import {
  gatherFacts,
  ItemSchema,
  makeCtx,
  parseItems,
  runItems,
} from "./engine.ts";
import { LocalRunner, type Runner, SshRunner } from "./runner.ts";

const TargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local") }),
  z.strictObject({
    kind: z.literal("ssh"),
    host: z.string().describe("Host name or address"),
    user: z.string().optional(),
    port: z.number().int().optional(),
    identityFile: z.string().optional().describe("Path to an ssh private key"),
    strictHostKeyChecking: z.enum(["yes", "accept-new", "no"]).default(
      "accept-new",
    ),
  }),
]);

const GlobalArgsSchema = z.object({
  target: TargetSchema.default({ kind: "local" }).describe(
    "The machine to configure: this one, or one reached over ssh",
  ),
  sourceDir: z.string().default("dotfiles").describe(
    "Directory holding the files items copy from. Relative paths are resolved from the swamp repository root",
  ),
  vars: z.record(z.string(), z.string()).default({}).describe(
    "Extra {{variables}} for templates and destinations",
  ),
  items: z.array(ItemSchema).default([]).meta({ foreignTemplate: true })
    .describe(
      "What the machine should have, applied in order",
    ),
});

const ItemResultSchema = z.object({
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  detail: z.string(),
});

const ReportSchema = z.object({
  machine: z.string(),
  os: z.string(),
  mode: z.enum(["plan", "apply"]),
  ok: z.boolean(),
  summary: z.record(z.string(), z.number()),
  items: z.array(ItemResultSchema),
  at: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

function makeRunner(target: GlobalArgs["target"]): Runner {
  return target.kind === "local" ? new LocalRunner() : new SshRunner(target);
}

// deno-lint-ignore no-explicit-any
type Context = any;

async function run(
  method: "plan" | "apply" | "verify",
  context: Context,
) {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const items = parseItems(g.items);
  const srcDir = isAbsolute(g.sourceDir)
    ? g.sourceDir
    : join(context.repoDir, g.sourceDir);
  const runner = makeRunner(g.target);
  try {
    const facts = await gatherFacts(runner);
    const mode = method === "apply" ? "apply" : "plan";
    const result = await runItems(
      items,
      makeCtx(runner, facts, srcDir, g.vars),
      mode,
    );
    const handle = await context.writeResource("report", method, {
      machine: runner.label,
      os: facts.os,
      mode,
      ok: result.ok,
      summary: result.summary,
      items: result.items,
      at: new Date().toISOString(),
    });
    for (const i of result.items) {
      if (i.status !== "unchanged" && i.status !== "skipped") {
        context.logger.info(
          `${runner.label}: ${i.status} ${i.name} ${i.detail}`,
        );
      }
    }
    const failed = result.items.filter((i) => i.status === "failed");
    if (failed.length) {
      throw new Error(
        `${runner.label}: ${failed.length} item(s) failed: ` +
          failed.map((i) => `${i.name} (${i.detail})`).join("; "),
      );
    }
    if (method === "verify") {
      const drift = result.items.filter((i) => i.status.startsWith("would-"));
      if (drift.length) {
        throw new Error(
          `${runner.label} has drifted in ${drift.length} item(s): ` +
            drift.map((i) => i.name).join(", "),
        );
      }
    }
    return { dataHandles: [handle] };
  } finally {
    await runner.close?.();
  }
}

/**
 * Model definition for `@puddleworks/dotfiles`: declare a machine's items,
 * then `plan`, `apply` or `verify` them locally or over ssh.
 */
export const model = {
  type: "@puddleworks/dotfiles",
  version: "2026.11.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    report: {
      description: "What a plan, apply or verify run found on the machine",
      schema: ReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    plan: {
      description: "Show what apply would change, without changing anything",
      arguments: z.object({}),
      execute: (_args: unknown, context: Context) => run("plan", context),
    },
    apply: {
      description: "Bring the machine to the declared state; safe to repeat",
      arguments: z.object({}),
      execute: (_args: unknown, context: Context) => run("apply", context),
    },
    verify: {
      description: "Fail if the machine differs from the declared state",
      arguments: z.object({}),
      execute: (_args: unknown, context: Context) => run("verify", context),
    },
  },
};
