export const notificationSender = "WareIQ <support@chainsoftwaresolutions.com>";

export function notificationMessage(kind: string, roleName: string) {
  const scope = kind === "platform" ? "platform" : "reporting";
  // Plain text only; names are administrator-supplied, never HTML.
  const role = roleName.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 100);
  return {
    subject: `Your WareIQ ${scope} access has changed`,
    text: `An administrator updated your WareIQ ${scope} access.\n\nNew role: ${role}.\n\n${
      kind === "platform"
        ? "This change affects platform privileges only. Client reporting assignments are managed separately."
        : roleName === "No reporting access"
          ? "Your reporting access has been revoked."
          : "Sign in to WareIQ to see your current reporting access. Available reports and warehouses depend on your assignments."
    }\n\nIf you did not expect this change, contact your WareIQ administrator. This email contains no warehouse or report data.`,
  };
}
