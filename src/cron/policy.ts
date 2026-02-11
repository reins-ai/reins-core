import type { Result } from "../result";
import { err, ok } from "../result";
import { CronError, type CronJobPayload } from "./types";

export type ApprovalStatus = "approved" | "pending" | "denied";

export interface CronPolicyResult {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

const APPROVAL_REQUIRED_ACTIONS = new Set([
  "spend_credits",
  "make_payment",
  "purchase",
  "billing",
  "charge",
]);

export function evaluateCronPolicy(payload: CronJobPayload): CronPolicyResult {
  const action = payload.action.toLowerCase();

  if (isBillingAction(action)) {
    return {
      allowed: true,
      requiresApproval: true,
      reason: "Billing/spending operations require user approval",
    };
  }

  if (isRecursiveCronAction(action)) {
    return {
      allowed: true,
      requiresApproval: true,
      reason: "Creating new cron jobs from cron requires user approval",
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    reason: "Action permitted under permissive cron policy",
  };
}

export function isRecursiveCronAction(action: string): boolean {
  const normalized = action.toLowerCase();
  return normalized === "schedule" || normalized === "create_schedule" || normalized === "schedule_cron";
}

export function isBillingAction(action: string): boolean {
  const normalized = action.toLowerCase();
  return (
    APPROVAL_REQUIRED_ACTIONS.has(normalized) ||
    normalized.includes("payment") ||
    normalized.includes("billing") ||
    normalized.includes("purchase")
  );
}

export function ensureCronActionAllowed(payload: CronJobPayload): Result<CronPolicyResult, CronError> {
  const policy = evaluateCronPolicy(payload);
  if (!policy.allowed) {
    return err(new CronError(policy.reason, "CRON_POLICY_DENIED"));
  }

  return ok(policy);
}
