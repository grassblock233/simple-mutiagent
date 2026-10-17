import { WorkflowEngine, type NodeRunner } from "../lib/workflow/engine";
import type { Workflow } from "../lib/workflow/schema";

type Options = ConstructorParameters<typeof WorkflowEngine>[2];

// The scheduler is tested with injected runners; production always supplies a real workspace.
export class TestWorkflowEngine extends WorkflowEngine {
  private completion?: Promise<void>;
  constructor(workflow: Workflow, runner: NodeRunner, options: Partial<Options> = {}) {
    super(workflow, runner, {
      ...options,
      real: options.real ?? {
        scope: ["src/math.ts", "src/math.test.ts"],
        baselineVersion: "test-v0",
        workspace: { id: "00000000-0000-4000-8000-000000000000", root: "/tmp/workflow-unit-fixture", selection: [{ path: "src", directory: true }], excludes: [] },
        allowPath: p => ["src/math.ts", "src/math.test.ts"].includes(p),
        allowCommand: c => c.executable === "node" && c.cwd === "." && JSON.stringify(c.args) === JSON.stringify(["--test", "src/math.test.ts"]),
      },
    });
  }
  override start() {
    return (this.completion ??= super.start().then(() => { this.finalize(); }));
  }
}
