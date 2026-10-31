import { expect, test } from "@playwright/test";
import { RuntimeRestartBudget } from "../../electron/runtime/runtime-restart-budget";

test("allows restarts until the limit is reached within the window", () => {
  const budget = new RuntimeRestartBudget(3, 60_000);
  expect(budget.recordFailure(0)).toBe(true);
  expect(budget.recordFailure(1_000)).toBe(true);
  expect(budget.recordFailure(2_000)).toBe(false);
  expect(budget.failuresInWindow).toBe(3);
});

test("forgets losses older than the window", () => {
  const budget = new RuntimeRestartBudget(3, 60_000);
  expect(budget.recordFailure(0)).toBe(true);
  expect(budget.recordFailure(10_000)).toBe(true);
  // The first loss is now outside the window, so this is the second recent one.
  expect(budget.recordFailure(60_000)).toBe(true);
  expect(budget.failuresInWindow).toBe(2);
  expect(budget.recordFailure(61_000)).toBe(false);
});
