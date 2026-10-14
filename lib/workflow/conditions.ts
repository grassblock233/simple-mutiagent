import { type Condition, type ReviewResult } from "./schema";

export function reviewFacts(review: ReviewResult, requireValidation = false) {
  const validationComplete =
    review.validations.every((v) => !v.required || v.status !== "missing") &&
    (!requireValidation ||
      review.validations.some((v) => v.required && v.status !== "missing"));
  return {
    blockingCount: review.issues.filter(
      (i) => i.severity === "blocking" && i.status !== "resolved",
    ).length,
    validationComplete,
    testsPassed:
      review.validations.length > 0 &&
      review.validations.every((v) => v.status === "passed"),
  };
}

export function matchesCondition(
  condition: Condition,
  facts: ReturnType<typeof reviewFacts>,
): boolean {
  const value = facts[condition.field];
  if (typeof value !== typeof condition.value)
    throw new Error(`条件字段 ${condition.field} 缺失或类型错误`);
  if (condition.operator === "gt")
    return (value as number) > (condition.value as number);
  return value === condition.value;
}
