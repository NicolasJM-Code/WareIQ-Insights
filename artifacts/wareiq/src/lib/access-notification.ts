export function notificationDescription(status: string | undefined) {
  if (status === 'queued') return 'An email notification is queued. Delivery may be delayed; access is already saved.';
  if (status === 'failed') return 'Access is saved, but an email could not be queued. Contact the account holder directly; do not repeat the role change.';
  return '';
}
