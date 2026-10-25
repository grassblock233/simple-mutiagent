import { createNode } from "../lib/workflow/templates";
import type { NodeKind, Workflow } from "../lib/workflow/schema";

// Legacy graphs only exercise saved/imported workflow compatibility.
export function legacyWorkflow(kind: "full" | "review"): Workflow {
  const kinds: NodeKind[] =
    kind === "review"
      ? ["read", "review", "output"]
      : [
          "read",
          "review",
          "branch",
          "repair",
          "rereview",
          "branch",
          "loop",
          "output",
        ];
  const ids =
    kind === "review"
      ? ["read", "review", "output"]
      : [
          "read",
          "review",
          "initial_branch",
          "repair",
          "rereview",
          "final_branch",
          "loop",
          "output",
        ];
  const positions =
    kind === "review"
      ? [
          [80, 150],
          [380, 150],
          [680, 150],
        ]
      : [
          [0, 40],
          [260, 40],
          [520, 40],
          [520, 270],
          [260, 270],
          [0, 270],
          [0, 490],
          [780, 40],
        ];
  const nodes = kinds.map((nodeKind, i) =>
    createNode(nodeKind, ids[i], ...(positions[i] as [number, number])),
  );
  const finalBranch = nodes.find((n) => n.id === "final_branch");
  if (finalBranch?.kind === "branch")
    finalBranch.inputs.review.sources = ["rereview"];
  const edge = (source: string, sourcePort: string, target: string) => ({
    id: `${source}-${sourcePort}-${target}`,
    source,
    sourcePort,
    target,
    targetPort: "in" as const,
  });
  const edges =
    kind === "review"
      ? [edge("read", "next", "review"), edge("review", "next", "output")]
      : [
          edge("read", "next", "review"),
          edge("review", "next", "initial_branch"),
          edge("initial_branch", "has_issues", "repair"),
          edge("initial_branch", "fallback", "output"),
          edge("repair", "next", "rereview"),
          edge("rereview", "next", "final_branch"),
          edge("final_branch", "has_issues", "loop"),
          edge("final_branch", "fallback", "output"),
          edge("loop", "continue", "repair"),
          edge("loop", "exit", "output"),
        ];
  return {
    formatVersion: 1,
    name: kind === "review" ? "仅审查" : "审查 · 修复 · 复审",
    nodes,
    edges,
  };
}

