export type AuditRole = "admin" | "supervisor" | "unassigned";
export type AuditOutcome = "succeeded" | "unchanged" | "denied" | "failed" | "unconfirmed";
export type AuditStart = {
  actorId: string;
  targetId: string | null;
  requestedRole: AuditRole | null;
  outcome?: AuditOutcome;
  reason?: string;
};
export interface AccessAuditStore {
  start: (entry: AuditStart) => Promise<string>;
  previous: (id: string, role: AuditRole) => Promise<void>;
  finish: (id: string, outcome: AuditOutcome, reason: string, resultingRole?: AuditRole) => Promise<void>;
}
