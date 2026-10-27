type Membership = {
  email: string; active: boolean; roleId: string; clientId: string;
  siteIds: string[]; primarySiteId: string | null;
};
type ReportingNotice = { recipient: string; roleName: string; kind: "reporting" };

// Compare effective assignments, not names or array ordering. Retrying the same
// saved form must not send again, including after an HTTP response is lost.
export function reportingChangeNotices(before: Membership | undefined, after: Membership | undefined, roleName: string): ReportingNotice[] {
  const same = before && after && before.email === after.email &&
    before.active === after.active && before.roleId === after.roleId &&
    before.clientId === after.clientId && before.primarySiteId === after.primarySiteId &&
    JSON.stringify([...before.siteIds].sort()) === JSON.stringify([...after.siteIds].sort());
  if (same) return [];
  const notices: ReportingNotice[] = [];
  if (before?.active && (!after || before.email !== after.email || !after.active)) {
    notices.push({ recipient: before.email, roleName: "No reporting access", kind: "reporting" });
  }
  if (after?.active) {
    notices.push({ recipient: after.email, roleName, kind: "reporting" });
  }
  return notices;
}
