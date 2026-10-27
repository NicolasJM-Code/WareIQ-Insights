---
name: Access notification lock ordering
description: Lock ordering and stale-role validation for platform access email delivery
---

Platform access email delivery must acquire the shared role lock before taking the notification row lock, validate the current Clerk role and event ID, then hold both through the provider request.

**Why:** Role changes hold the shared role lock while updating Clerk metadata. Taking the outbox row lock first can deadlock with those changes, and releasing the role lock before sending lets a newer role change overtake an older email.

**How to apply:** Any platform notification worker or retry path must use this ordering. Keep the stable provider idempotency key and update the outbox state before releasing the row lock.
