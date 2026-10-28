---
name: Warehouse VPN requirements
description: User-confirmed OpenVPN infrastructure and required VPN-before-SQL connection order.
---

WareIQ's requested connection order is VPN first, then SQL. The user confirmed
OpenVPN and an existing VPN-connected server.

**Why:** The user explicitly requested this order and confirmed that infrastructure
is already available.

**How to apply:** Integrate with the existing OpenVPN infrastructure rather than
assuming a new VPN provider or exposing MySQL publicly. Confirm the server's OS
before giving installation commands; an existing OpenVPN server does not imply Linux.

Legacy single-connector settings must not be automatically assigned to a
warehouse when adopting per-site VPN configuration.

**Why:** A pre-existing global endpoint contains no evidence of which client or
site its credentials are approved for. Inferring a default would bypass the
explicit owner approval required by the multi-warehouse security boundary.

**How to apply:** Require an explicit client/site approval even for a single
warehouse; document the coordinated connector/API configuration migration rather
than adding a legacy VPN fallback.
