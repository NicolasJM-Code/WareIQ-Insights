export const notificationSender = "WareIQ <support@chainsoftwaresolutions.com>";

export function notificationMessage(kind: string, roleName: string) {
  if (kind === "vpn_outage" || kind === "vpn_recovery") {
    return kind === "vpn_outage" ? {
      subject: "WareIQ warehouse VPN access is unavailable",
      text: "Two consecutive background checks could not verify the configured OpenVPN connector and warehouse database route. MySQL access through this route may be unavailable. Check the connector service, VPN interface, private DNS and database TCP route. Open WareIQ Settings for current monitoring status. No SQL login was attempted by these checks.",
    } : {
      subject: "WareIQ warehouse VPN access has recovered",
      text: "A background check has verified the configured OpenVPN connector, VPN route and warehouse database TCP reachability after an outage. This does not verify SQL authentication, permissions or reporting queries. Open WareIQ Settings to run a SQL connection test if needed.",
    };
  }
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
