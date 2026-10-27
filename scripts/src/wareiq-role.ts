import { createClerkClient } from '@clerk/backend';

// Explicit owner-operated grant/revoke command; never called during startup.
// The operator must verify ownership of the exact email before invoking this.
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const email = args.includes('--email') ? option('--email')?.trim().toLowerCase() : undefined;
const role = args.includes('--role') ? option('--role') : undefined;
if (!email || !['admin', 'supervisor', 'unassigned'].includes(role ?? '') ||
    !args.includes('--confirm-ownership')) {
  throw new Error('Usage: pnpm --filter @workspace/scripts wareiq:role --email <verified-email> --role admin|supervisor|unassigned --confirm-ownership');
}
const key = process.env.CLERK_SECRET_KEY;
if (!key) throw new Error('Managed authentication is not configured.');
if (key.startsWith('sk_live_') && !args.includes('--confirm-production')) {
  throw new Error('Production changes also require --confirm-production in the target production environment.');
}
const client = createClerkClient({ secretKey: key });
const matches = await client.users.getUserList({ emailAddress: [email] });
const users = matches.data.filter((u) => u.emailAddresses.some((e) =>
  e.emailAddress.toLowerCase() === email && e.verification?.status === 'verified'));
if (users.length !== 1) {
  throw new Error('Exactly one existing account with a verified matching email is required. Sign up and verify the email first.');
}
const user = users[0];
if (user.banned || user.locked) throw new Error('Cannot grant access to a locked or banned account.');
if (user.publicMetadata.role === role) {
  console.info('The account already has this role; nothing changed.');
} else {
  await client.users.updateUserMetadata(user.id, { publicMetadata: { role } });
  console.info(`WareIQ role updated to ${role}. The next API request uses the new permissions.`);
}
