// Minimal CBOR (RFC 8949) decoder — ONLY the subset WebAuthn needs: the attestation object map
// ({fmt, attStmt, authData}) and the COSE_Key map inside authData (integer-keyed, byte-string
// values). We hand-roll it (no dependency) exactly the way the rest of a7t.chat's crypto is
// self-contained. It decodes unsigned/negative integers, byte/text strings, arrays, definite-length
// maps, tags (transparently unwrapped) and the simple values false/true/null/undefined; anything
// else — indefinite lengths, floats, or a truncated buffer — throws, so a malformed authenticator
// payload fails CLOSED rather than silently mis-parsing. Maps become JS `Map`s so integer COSE keys
// (including the negative ones a COSE_Key uses) survive intact.

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

interface Reader {
  buf: Buffer;
  pos: number;
}

// The WebAuthn subset is shallow (attestation map → COSE map is ~2 levels); cap nesting well above
// that so a crafted deeply-nested payload can't exhaust the stack (fail closed instead).
const MAX_DEPTH = 32;

function need(r: Reader, n: number): void {
  if (n < 0 || r.pos + n > r.buf.length) throw new CborError("unexpected end of CBOR input");
}

// Read the argument that follows an initial byte (the length / value), per the additional-info bits.
function readArgument(r: Reader, info: number): number {
  if (info < 24) return info;
  if (info === 24) {
    need(r, 1);
    const v = r.buf.readUInt8(r.pos);
    r.pos += 1;
    return v;
  }
  if (info === 25) {
    need(r, 2);
    const v = r.buf.readUInt16BE(r.pos);
    r.pos += 2;
    return v;
  }
  if (info === 26) {
    need(r, 4);
    const v = r.buf.readUInt32BE(r.pos);
    r.pos += 4;
    return v;
  }
  if (info === 27) {
    need(r, 8);
    const hi = r.buf.readUInt32BE(r.pos);
    const lo = r.buf.readUInt32BE(r.pos + 4);
    r.pos += 8;
    const v = hi * 0x1_0000_0000 + lo;
    // Guard the max-length case: authenticator payloads are tiny, so a value beyond the safe
    // integer range is malformed — reject rather than lose precision.
    if (!Number.isSafeInteger(v)) throw new CborError("CBOR integer out of range");
    return v;
  }
  // 28–30 are reserved; 31 is indefinite length (unsupported here — fail closed).
  throw new CborError(`unsupported CBOR length encoding ${info}`);
}

function readItem(r: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CborError("CBOR nesting too deep");
  need(r, 1);
  const initial = r.buf.readUInt8(r.pos);
  r.pos += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0: // unsigned integer
      return readArgument(r, info);
    case 1: // negative integer
      return -1 - readArgument(r, info);
    case 2: {
      // byte string
      const len = readArgument(r, info);
      need(r, len);
      const bytes = Buffer.from(r.buf.subarray(r.pos, r.pos + len));
      r.pos += len;
      return bytes;
    }
    case 3: {
      // text string (UTF-8)
      const len = readArgument(r, info);
      need(r, len);
      const s = r.buf.toString("utf8", r.pos, r.pos + len);
      r.pos += len;
      return s;
    }
    case 4: {
      // array
      const len = readArgument(r, info);
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) arr.push(readItem(r, depth + 1));
      return arr;
    }
    case 5: {
      // map — keep it a Map so integer keys (incl. negatives) are preserved distinctly.
      const len = readArgument(r, info);
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < len; i++) {
        const key = readItem(r, depth + 1);
        const value = readItem(r, depth + 1);
        map.set(key, value);
      }
      return map;
    }
    case 6: {
      // tag — decode (and discard) the tag number, return the tagged item transparently.
      readArgument(r, info);
      return readItem(r, depth + 1);
    }
    case 7: {
      // simple values only — floats/break are unsupported (never appear in the WebAuthn subset).
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      throw new CborError(`unsupported CBOR simple value ${info}`);
    }
    default:
      throw new CborError(`unsupported CBOR major type ${major}`);
  }
}

// Decode the FIRST complete CBOR item in `buf`. Trailing bytes after it are allowed (the
// attestation object is a single top-level map; the authData byte string carries its own length).
export function decodeCbor(buf: Buffer): unknown {
  return readItem({ buf, pos: 0 }, 0);
}
