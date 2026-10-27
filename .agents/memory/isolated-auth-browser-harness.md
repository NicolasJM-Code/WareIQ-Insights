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

When delaying an authorization response to prove recovery ordering, observe the browser's original fetch and return its original response rather than replacing it with Playwright's API-client request.

**Why:** During real Development cookie recovery, Playwright `route.fetch()` did not produce the authenticated access summary even though the SDK had restored the session cookie; forwarding the original browser fetch preserved the actual handshake and passed.

**How to apply:** Delay only delivery to the hook, preserve the original request and response, restore fetch in cleanup, and never manufacture cookies or permission summaries.
## Verified email versus fresh-browser verification

A backend-created, verified email can still encounter Clerk's client-trust email challenge in a new browser. Do not disable the challenge or replace the screen with a sign-in ticket to make a hosted-screen check pass.

**Why:** The live Development password journey required an additional email code even though account creation had already verified the address. Identity verification and trusting a fresh browser are separate checks.

**How to apply:** Use disposable Development test-email addresses and Clerk's supported test code for email challenges. Keep unsupported MFA/SSO factors explicit rather than silently bypassing them or claiming the password journey covers them.
