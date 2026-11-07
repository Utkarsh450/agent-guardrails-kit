import { ALLOW_MARKER, SECRET_PATTERNS, entropy, isSecretPath, scanLine, scanText } from "../git/git-checks/git-checks.mjs";

/**
 * Lines for the project's .gitignore so secret files are never added by accident.
 * Example files (.env.example) stay trackable on purpose.
 */
export const SECRETS_GITIGNORE_LINES: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".netrc",
  ".pgpass",
];

/** The secret scanner, shared with the git hooks and CI (one implementation, one set of patterns). */
export { ALLOW_MARKER, SECRET_PATTERNS, entropy, isSecretPath, scanLine, scanText };
