// Canonical hyphenated UUID of any version. Postgres also accepts braces or no hyphens; the API
// insists on the canonical form.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
