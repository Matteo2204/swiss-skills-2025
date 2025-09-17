import crypto from 'node:crypto';

/**
 * Diffie–Hellman (g=5, p=0xFFFFFFFB) with PSK-based key derivation.
 * HMAC/MAC over payload only, via rolling 32-bit (h=31*h+octet) then XOR with key.
 *
 * Assunzioni minime:
 * - TX/RX key possono essere identiche (direzioni non specificate) → qui sono identiche.
 * - Per l'operazione XOR della MAC usiamo i primi 4 byte della chiave in big-endian.
 * - "hello"/"response" sono i public key bytes DH.
 */

const P_HEX = 'fffffffb'; // 0xFFFFFFFB
const G_NUM = 5;
const PSK_HEX = 'feed5eed'; // 0xFEED5EED
const BYPASS_CONST = 0xfadedbed >>> 0;

function beHexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

export class Session {
  private dh?: crypto.DiffieHellman;
  private shared?: Buffer;
  private bypass = false;
  private readonly prime: Buffer;
  private readonly generator: Buffer;
  private readonly psk: Buffer;
  private useSoftDH = false;
  private privBI?: bigint;
  private pubBI?: bigint;
  private sharedBI?: bigint;

  constructor(prime: Buffer = beHexToBuffer(P_HEX), generator: Buffer = Buffer.from([G_NUM]), psk: Buffer = beHexToBuffer(PSK_HEX)) {
    this.prime = prime;
    this.generator = generator;
    this.psk = psk;
  }

  beginHandshake(): Buffer {
    // Try OpenSSL DH first; fallback to software BigInt DH if modulus is considered too small
    try {
      this.dh = crypto.createDiffieHellman(this.prime, this.generator);
      this.dh.generateKeys();
      this.useSoftDH = false;
      return this.dh.getPublicKey();
    } catch (e: any) {
      if (e && e.code === 'ERR_OSSL_DH_MODULUS_TOO_SMALL') {
        // Fallback: software DH using BigInt with given small prime
        this.useSoftDH = true;
        const P = BigInt('0x' + P_HEX);
        const G = BigInt(G_NUM);
        // private in [1, P-2]
        const rnd = crypto.randomBytes(8); // 64-bit to reduce bias before mod
        const r = BigInt('0x' + rnd.toString('hex'));
        const priv = (r % (P - 2n)) + 1n;
        const pub = modPowBI(G, priv, P);
        this.privBI = priv;
        this.pubBI = pub;
        return bigToBufBE(pub, 4);
      }
      throw e;
    }
  }

  acceptChallenge(challenge: Uint8Array): Buffer {
    if (!this.dh && !this.useSoftDH) {
      // If beginHandshake was not called, generate on-the-fly
      this.beginHandshake();
    }
    if (this.useSoftDH) {
      const P = BigInt('0x' + P_HEX);
      const peerPub = bufToBigBE(Buffer.from(challenge));
      const shared = modPowBI(peerPub, this.privBI!, P);
      this.sharedBI = shared;
      // Our public key is based on our privBI
      return bigToBufBE(this.pubBI!, 4);
    } else {
      const peerPub = Buffer.from(challenge);
      this.shared = this.dh!.computeSecret(peerPub);
      return this.dh!.getPublicKey();
    }
  }

  deriveKeys(): { txKey: Buffer; rxKey: Buffer } {
    let sharedBuf: Buffer | undefined;
    if (this.useSoftDH) {
      if (this.sharedBI === undefined) throw new Error('Handshake not completed');
      sharedBuf = bigToBufBE(this.sharedBI, 4);
    } else {
      if (!this.shared) throw new Error('Handshake not completed');
      sharedBuf = this.shared;
    }
    // Minimal KDF: SHA-256(shared || psk)
    const keyMat = crypto.createHash('sha256').update(sharedBuf).update(this.psk).digest();
    // Identical TX/RX keys (assunzione dichiarata)
    const txKey = Buffer.from(keyMat);
    const rxKey = Buffer.from(keyMat);
    return { txKey, rxKey };
  }

  useBypass(on: boolean) {
    this.bypass = on;
  }

  calcMAC(payload: Uint8Array, key: Buffer): number {
    if (this.bypass) return BYPASS_CONST;
    let h = 0 >>> 0;
    for (let i = 0; i < payload.length; i++) {
      h = (Math.imul(31, h) + payload[i]) >>> 0;
    }
    const keyXor = key.length >= 4 ? key.readUInt32BE(0) >>> 0 : 0;
    return (h ^ keyXor) >>> 0;
  }
}

// Default session instance to satisfy required functional API
const __default = new Session();

export function beginHandshake(): Buffer { return __default.beginHandshake(); }
export function acceptChallenge(challenge: Uint8Array): Buffer { return __default.acceptChallenge(challenge); }
export function deriveKeys(): { txKey: Buffer; rxKey: Buffer } { return __default.deriveKeys(); }
export function useBypass(on: boolean) { __default.useBypass(on); }
export function calcMAC(payload: Uint8Array, key: Buffer): number { return __default.calcMAC(payload, key); }

export { BYPASS_CONST };

// --- helpers: BigInt DH ---
function modPowBI(base: bigint, exp: bigint, mod: bigint): bigint {
  let res = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return res;
}

function bigToBufBE(n: bigint, length: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length === length) return buf;
  if (buf.length > length) return buf.slice(buf.length - length);
  const out = Buffer.alloc(length);
  buf.copy(out, length - buf.length);
  return out;
}

function bufToBigBE(buf: Buffer): bigint {
  return BigInt('0x' + buf.toString('hex'));
}
