export type AppRole = "admin" | "supervisor" | "unassigned";

export function appRole(value: unknown): AppRole {
  return value === "admin" || value === "supervisor" ? value : "unassigned";
}

// Match the email shown to administrators, not an unrelated secondary address.
export function verifiedPrimaryEmail(user: {
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; verification: { status: string } | null }[];
}): boolean {
  return user.emailAddresses.some((email) =>
    email.id === user.primaryEmailAddressId && email.verification?.status === "verified");
}
