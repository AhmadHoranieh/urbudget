// A stand-in for Apple's signing chain: a root, a WWDR-like intermediate and an App Store-like
// leaf, generated here and encoded by hand in DER, so tests can sign StoreKit and notification
// JWS the way Apple does. Options make each kind of broken chain the verifier must refuse.
import { base64url, hex, utf8 } from "../src/util";

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const length = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Uint8Array[]) => {
  const body = concat(parts);
  return concat([Uint8Array.of(tag, ...length(body.length)), body]);
};
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
function oid(dotted: string) {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (let value of rest) {
    const chunk = [value & 0x7f];
    for (value = Math.floor(value / 128); value; value = Math.floor(value / 128)) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}
/** A non-negative DER INTEGER from big-endian bytes. */
const integer = (bytes: Uint8Array) => {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1);
  return tlv(0x02, value[0] & 0x80 ? concat([Uint8Array.of(0), value]) : value);
};
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, utf8(cn)))));
const utcTime = (ms: number) => tlv(0x17, utf8(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

const ALGORITHM = { "SHA-256": "1.2.840.10045.4.3.2", "SHA-384": "1.2.840.10045.4.3.3" } as const;
type Hash = keyof typeof ALGORITHM;
const CURVE = { "P-256": 32, "P-384": 48 } as const;

export interface Signer { keys: CryptoKeyPair; curve: keyof typeof CURVE; name: string; der: Uint8Array }

export const newKeys = (curve: keyof typeof CURVE) =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

interface CertificateOptions {
  name: string;
  curve: keyof typeof CURVE;
  /** Signs it; a root signs itself. */
  issuer?: Signer;
  hash?: Hash;
  ca?: boolean;
  markers?: string[];
  notBefore?: number;
  notAfter?: number;
  keys?: CryptoKeyPair;
}

export async function certificate(options: CertificateOptions): Promise<Signer> {
  const keys = options.keys ?? await newKeys(options.curve);
  const hash = options.hash ?? ((options.issuer?.curve ?? options.curve) === "P-384" ? "SHA-384" : "SHA-256");
  const algorithm = seq(oid(ALGORITHM[hash]));
  const extensions = [
    seq(oid("2.5.29.19"), tlv(0x01, Uint8Array.of(0xff)), tlv(0x04, seq(...(options.ca ? [tlv(0x01, Uint8Array.of(0xff))] : [])))),
    ...(options.markers ?? []).map((marker) => seq(oid(marker), tlv(0x04, tlv(0x05)))),
  ];
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(crypto.getRandomValues(new Uint8Array(8))),
    algorithm,
    name(options.issuer?.name ?? options.name),
    seq(utcTime(options.notBefore ?? Date.now() - 365 * 86_400_000), utcTime(options.notAfter ?? Date.now() + 10 * 365 * 86_400_000)),
    name(options.name),
    new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
    tlv(0xa3, seq(...extensions)),
  );
  const signer = options.issuer ?? { keys, curve: options.curve };
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, signer.keys.privateKey, tbs));
  const size = CURVE[signer.curve];
  const signature = seq(integer(raw.subarray(0, size)), integer(raw.subarray(size)));
  return { keys, curve: options.curve, name: options.name, der: seq(tbs, algorithm, tlv(0x03, Uint8Array.of(0), signature)) };
}

export const APPLE_INTERMEDIATE = "1.2.840.113635.100.6.2.1";
export const APPLE_LEAF = "1.2.840.113635.100.6.11.1";

export interface Chain { root: Signer; intermediate: Signer; leaf: Signer; rootSha256: string }

/** Apple's shape: a P-384 root and intermediate, and a P-256 leaf that signs ES256. */
export async function appleLikeChain(overrides: { intermediate?: Partial<CertificateOptions>; leaf?: Partial<CertificateOptions> } = {}): Promise<Chain> {
  const root = await certificate({ name: "Test Root CA - G3", curve: "P-384", ca: true });
  const intermediate = await certificate({ name: "Test WWDR - G6", curve: "P-384", ca: true, issuer: root, markers: [APPLE_INTERMEDIATE], ...overrides.intermediate });
  const leaf = await certificate({ name: "Test App Store signing", curve: "P-256", issuer: intermediate, markers: [APPLE_LEAF], ...overrides.leaf });
  return { root, intermediate, leaf, rootSha256: hex(await crypto.subtle.digest("SHA-256", root.der)) };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A compact JWS signed by the chain's leaf, with the chain in x5c (leaf first, root last). */
export async function signJws(chain: Chain, payload: unknown, header: Record<string, unknown> = {}): Promise<string> {
  const head = base64url(utf8(JSON.stringify({ alg: "ES256", x5c: [chain.leaf, chain.intermediate, chain.root].map((c) => b64(c.der)), ...header })));
  const body = base64url(utf8(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chain.leaf.keys.privateKey, utf8(`${head}.${body}`));
  return `${head}.${body}.${base64url(signature)}`;
}
