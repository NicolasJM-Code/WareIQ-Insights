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
