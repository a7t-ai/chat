import { createHash, randomBytes } from "node:crypto";

// Opaque tokens (not JWT): revocation is one row update, and we do a DB lookup per
// request anyway. We store ONLY the SHA-256 hash; the raw token is shown once.

const TOKEN_PREFIX = "a7t_";

export function generateToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
