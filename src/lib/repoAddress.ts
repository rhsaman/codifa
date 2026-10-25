/** Whether a `/plugin install` argument is an ADDRESS rather than a NAME.
 *
 *  `install` only reads an existing bundle; a bare word like `eurusd` is the
 *  name of a bundle the user wants CREATED. The backend refuses it with the
 *  same distinction (see `repo::looks_like_repo_address`), and the composer has
 *  to route it to `/plugin create` instead of spending a turn on a doomed
 *  install — so the two must agree on what "looks like an address" means.
 *
 *  Kept dependency-free so it runs under plain Node in the test runner.
 */
export function looksLikeRepoAddress(spec: string): boolean {
  const raw = spec.trim()
  if (!raw) return false
  // `https://…`, `owner/repo`, `/an/absolute/path`, `./relative`, `~/local`.
  if (raw.includes('/')) return true
  // `git@github.com:owner/repo`.
  if (raw.includes('@') && raw.includes(':')) return true
  // `github.com:owner/repo` — a host with a colon but no slash stays an address.
  return false
}
