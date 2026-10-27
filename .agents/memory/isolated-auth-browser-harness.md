---
name: Isolated auth browser harness
description: Keep browser authorization checks independent from the production preview cache and report data
---
An opt-in authorization browser harness should have its own Vite dependency cache and must render only harmless protected markers instead of importing report datasets.

**Why:** The first isolated browser run fetched a stale/missing reporting module through the preview's shared optimized dependencies even while the source file existed. Separating the cache and catalog made the real browser handshake test reliable without loading report content.

**How to apply:** When changing browser authorization checks, preserve the separate optimization cache and harmless report-catalog boundary. Keep the production auth provider, hooks and guards real.

For renewal checks, observe SDK-written cookies passively and prove access after the original token expires; do not call token-refresh methods during the observation.

**Why:** A test-triggered refresh can hide a broken automatic renewal timer. A denial-only expiry test cannot establish that a valid open session stays authorized.

**How to apply:** Use the same open document and session, require advancing cookie issuance/expiry, then require a fresh server access response. After blocking renewal, use the latest cookie's expiry rather than the initial one.
## Verified email versus fresh-browser verification

A backend-created, verified email can still encounter Clerk's client-trust email challenge in a new browser. Do not disable the challenge or replace the screen with a sign-in ticket to make a hosted-screen check pass.

**Why:** The live Development password journey required an additional email code even though account creation had already verified the address. Identity verification and trusting a fresh browser are separate checks.

**How to apply:** Use disposable Development test-email addresses and Clerk's supported test code for email challenges. Keep unsupported MFA/SSO factors explicit rather than silently bypassing them or claiming the password journey covers them.
