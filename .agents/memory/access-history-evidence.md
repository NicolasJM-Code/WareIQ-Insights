---
name: Historical access-change evidence
description: Why interrupted provider updates must remain unconfirmed without causal evidence
---

Do not reconcile an interrupted access-change attempt as successful merely because
the current provider role matches its requested role.

**Why:** PostgreSQL and Clerk cannot share an atomic transaction. A later
administrator action can produce the same current role, so a current-role read
does not establish what an earlier interrupted request actually did.

**How to apply:** Preserve the unknown historical outcome unless there is causal
evidence for that specific attempt. Show current permissions separately and
retain the warning to refresh them before retrying.
