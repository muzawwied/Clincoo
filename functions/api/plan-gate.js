// Helper kecil: prefix key D1 untuk user ('u<id>:' atau legacy tanpa prefix).
export function userKeyPrefix(user) {
  if (user && user.id) return 'u' + user.id + ':';
  return '';
}
