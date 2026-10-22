// Apple's signed data: StoreKit 2 transactions, renewal info and App Store Server Notifications V2
// are each a JWS (ES256) whose x5c header carries the signing chain. The chain must end in Apple
// Root CA - G3, pinned below, with every signature, validity period and Apple's marker extensions
// in place. Nothing is fetched: the chain travels with the data.
import { fromBase64url, hex, utf8 } from "../util";

/**
 * SHA-256 of the DER bytes of Apple Root CA - G3, from https://www.apple.com/certificateauthority/
 * (fingerprint as Apple's lists of trusted roots publish it). Tests add the root they generate.
 */
export const appleRoots = new Set(["63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179"]);
/** Apple marks its WWDR intermediate and its App Store signing certificates with these extensions. */
const INTERMEDIATE_MARKER = "1.2.840.113635.100.6.2.1";
const LEAF_MARKER = "1.2.840.113635.100.6.11.1";
const CURVES: Record<string, { name: string; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};
const HASHES: Record<string, string> = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384" };

class Malformed extends Error {}

interface Der { tag: number; all: Uint8Array; body: Uint8Array }

function der(bytes: Uint8Array, at = 0): Der {
  if (at + 2 > bytes.length) throw new Malformed();
  const tag = bytes[at];
  let length = bytes[at + 1];
  let header = 2;
  if (length === 0x80) throw new Malformed();
  if (length > 0x80) {
    const count = length & 0x7f;
    if (count > 3 || at + 2 + count > bytes.length) throw new Malformed();
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[at + 2 + i];
    header += count;
  }
  const end = at + header + length;
  if (end > bytes.length) throw new Malformed();
  return { tag, all: bytes.subarray(at, end), body: bytes.subarray(at + header, end) };
}

function items(node: Der, tag = 0x30): Der[] {
  if (node.tag !== tag) throw new Malformed();
  const list: Der[] = [];
  for (let at = 0; at < node.body.length; at += list[list.length - 1].all.length) list.push(der(node.body, at));
  return list;
}

function oid(node: Der | undefined): string {
  if (node?.tag !== 0x06 || !node.body.length) throw new Malformed();
  const parts = [Math.floor(node.body[0] / 40), node.body[0] % 40];
  let value = 0;
  for (const byte of node.body.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) { parts.push(value); value = 0; }
  }
  return parts.join(".");
}

function time(node: Der | undefined): number {
  const text = new TextDecoder().decode(node?.body);
  const match = node?.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
    : node?.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : null;
  if (!match) throw new Malformed();
  const year = Number(match[1]) + (node!.tag === 0x17 ? (Number(match[1]) < 50 ? 2000 : 1900) : 0);
  return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  algorithm: string;
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array;
  curve: { name: string; size: number };
  ca: boolean;
  extensions: Set<string>;
}

function certificate(bytes: Uint8Array): Certificate {
  const outer = der(bytes);
  if (outer.all.length !== bytes.length) throw new Malformed();
  const [tbs, algorithm, signature] = items(outer);
  const fields = items(tbs);
  const [, inner, issuer, validity, subject, spki, ...rest] = fields[0]?.tag === 0xa0 ? fields.slice(1) : fields;
  const [notBefore, notAfter] = items(validity);
  const [keyAlgorithm] = items(spki);
  const [keyType, curveId] = items(keyAlgorithm);
  const curve = CURVES[oid(curveId)];
  if (oid(keyType) !== "1.2.840.10045.2.1" || !curve) throw new Malformed();
  const signed = oid(items(algorithm)[0]);
  if (signed !== oid(items(inner)[0])) throw new Malformed();
  // BIT STRING: a leading count of unused bits, which is zero for a DER signature.
  if (signature?.tag !== 0x03 || signature.body[0] !== 0) throw new Malformed();
  const extensions = new Set<string>();
  let ca = false;
  const listed = rest.find((field) => field.tag === 0xa3);
  for (const extension of listed ? items(items(listed, 0xa3)[0]) : []) {
    const parts = items(extension);
    const id = oid(parts[0]);
    extensions.add(id);
    if (id === "2.5.29.19") {
      // basicConstraints: SEQUENCE { cA BOOLEAN DEFAULT FALSE, ... } inside the OCTET STRING.
      const value = parts[parts.length - 1];
      if (value.tag !== 0x04) throw new Malformed();
      const first = items(der(value.body))[0];
      ca = first?.tag === 0x01 && first.body[0] !== 0;
    }
  }
  return {
    der: bytes, tbs: tbs.all, algorithm: signed, signature: signature.body.subarray(1),
    issuer: issuer.all, subject: subject.all, notBefore: time(notBefore), notAfter: time(notAfter),
    spki: spki.all, curve, ca, extensions,
  };
}

/** A DER ECDSA-Sig-Value as WebCrypto's raw r‖s, each padded to the curve's size. */
function rawSignature(signature: Uint8Array, size: number): Uint8Array {
  const raw = new Uint8Array(size * 2);
  items(der(signature)).forEach((integer, i) => {
    if (integer.tag !== 0x02 || i > 1) throw new Malformed();
    let value = integer.body;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new Malformed();
    raw.set(value, i * size + size - value.length);
  });
  return raw;
}

const publicKey = (certificate: Certificate) =>
  crypto.subtle.importKey("spki", certificate.spki, { name: "ECDSA", namedCurve: certificate.curve.name }, false, ["verify"]);

async function signedBy(certificate: Certificate, issuer: Certificate): Promise<boolean> {
  const hash = HASHES[certificate.algorithm];
  if (!hash || !same(certificate.issuer, issuer.subject)) return false;
  return crypto.subtle.verify({ name: "ECDSA", hash }, await publicKey(issuer),
    rawSignature(certificate.signature, issuer.curve.size), certificate.tbs);
}

const decode = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Malformed();
  return value as Record<string, unknown>;
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * The payload of a JWS that Apple signed, or null. Certificates must be valid when Apple signed
 * the payload (its `signedDate`), as Apple's own App Store Server Library checks them.
 */
export async function verifyAppleJws(jws: unknown): Promise<Record<string, unknown> | null> {
  // A notification nests a signed transaction and renewal info, each with its own chain.
  if (typeof jws !== "string" || jws.length > 65_536) return null;
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const header = decode(parts[0]);
    const x5c = header.x5c;
    if (header.alg !== "ES256" || !Array.isArray(x5c) || x5c.length !== 3 ||
        x5c.some((entry) => typeof entry !== "string" || entry.length > 8192)) return null;
    const [leaf, intermediate, root] = (x5c as string[]).map((entry) => certificate(fromBase64(entry)));
    if (!appleRoots.has(hex(await crypto.subtle.digest("SHA-256", root.der)))) return null;
    const payload = decode(parts[1]);
    const at = payload.signedDate;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if ([leaf, intermediate, root].some((c) => at < c.notBefore || at > c.notAfter)) return null;
    if (!root.ca || !intermediate.ca || leaf.ca || leaf.curve.name !== "P-256" ||
        !intermediate.extensions.has(INTERMEDIATE_MARKER) || !leaf.extensions.has(LEAF_MARKER)) return null;
    if (!(await signedBy(intermediate, root)) || !(await signedBy(leaf, intermediate))) return null;
    const signature = fromBase64url(parts[2]);
    if (signature.length !== 64) return null;
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(leaf), signature, utf8(`${parts[0]}.${parts[1]}`));
    return valid ? payload : null;
  } catch {
    // Malformed certificates, base64 or JSON, and keys WebCrypto refuses, all mean "not Apple's".
    return null;
  }
}
