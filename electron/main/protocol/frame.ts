/**
 * Protocol framing utilities
 * SoF = 0xAA
 * LEN = 7-bit big-endian varint (MSB=1 on continuation, MSB=0 on last)
 * Payload
 * CHK = two's complement 16-bit of the sum of all octets excluding CHK
 *
 * Assumptions (least invasive):
 * - CHK is encoded as big-endian (high byte first) when appended to the frame.
 * - decode() returns payloads (not the full frame).
 */

export type ParserState = {
  partial: boolean;
  stage: 'idle' | 'sof' | 'len' | 'payload' | 'chk';
  len?: number; // expected payload length, if known
  lenBytes?: number; // number of LEN bytes parsed (partial)
  bytesNeeded?: number; // additional bytes needed to complete current frame
};

const SOF = 0xAA;
const MAX_LEN_BYTES = 5; // supports payload lengths up to 2^(7*5)-1

export function calcChecksum(frameWithoutCHK: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < frameWithoutCHK.length; i++) {
    sum = (sum + frameWithoutCHK[i]) & 0xffff;
  }
  // Two's complement so that (sum + chk) & 0xFFFF === 0
  return (0x10000 - sum) & 0xffff;
}

function encodeVarint7BigEndian(value: number): Uint8Array {
  if (value < 0) throw new Error('LEN must be >= 0');
  if (value === 0) return Uint8Array.of(0x00);
  const parts: number[] = [];
  let v = value >>> 0;
  while (v > 0) {
    parts.unshift(v & 0x7f);
    v >>>= 7;
  }
  for (let i = 0; i < parts.length - 1; i++) parts[i] |= 0x80; // continuation MSB=1
  return Uint8Array.from(parts);
}

function decodeVarint7BigEndian(bytes: Uint8Array, start: number): { value?: number; consumed: number; needsMore?: boolean } {
  let val = 0;
  let i = start;
  let count = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    count++;
    val = ((val << 7) | (b & 0x7f)) >>> 0;
    if ((b & 0x80) === 0) {
      return { value: val >>> 0, consumed: count };
    }
    if (count >= MAX_LEN_BYTES) {
      // Too many bytes for LEN → treat as invalid length; signal completion to allow caller to skip this SoF
      return { value: undefined, consumed: count };
    }
  }
  return { consumed: count, needsMore: true };
}

export function encode(payload: Uint8Array): Uint8Array {
  const lenBytes = encodeVarint7BigEndian(payload.length);
  const frameNoChk = new Uint8Array(1 + lenBytes.length + payload.length);
  frameNoChk[0] = SOF;
  frameNoChk.set(lenBytes, 1);
  frameNoChk.set(payload, 1 + lenBytes.length);
  const chk = calcChecksum(frameNoChk);
  const out = new Uint8Array(frameNoChk.length + 2);
  out.set(frameNoChk, 0);
  out[out.length - 2] = (chk >>> 8) & 0xff; // big-endian
  out[out.length - 1] = chk & 0xff;
  return out;
}

export function decode(
  stream: Buffer | Uint8Array,
  carry?: ParserState
): { frames: Uint8Array[]; rest: Uint8Array; state: ParserState } {
  // Merge with carry.rest by simply prepending the previous rest (stateless parsing)
  const input = toUint8Array(stream);
  const merged = input; // carry.rest is expected to be fed by caller; we keep state minimal

  const frames: Uint8Array[] = [];
  let i = 0;
  let state: ParserState = { partial: false, stage: 'idle' };

  while (i < merged.length) {
    // Seek SoF
    if (merged[i] !== SOF) {
      i++;
      continue;
    }

    const sofIndex = i;
    const lenStart = sofIndex + 1;
    if (lenStart >= merged.length) {
      state = { partial: true, stage: 'len', lenBytes: 0, bytesNeeded: 1 };
      break; // need more data for at least 1 LEN byte
    }

    // Decode LEN varint
    const lenRes = decodeVarint7BigEndian(merged, lenStart);
    if (lenRes.needsMore) {
      state = { partial: true, stage: 'len', lenBytes: lenRes.consumed, bytesNeeded: 1 };
      break;
    }
    if (lenRes.value === undefined) {
      // Invalid LEN (too long) → discard this SoF and continue searching
      i = sofIndex + 1;
      continue;
    }
    const payloadLen = lenRes.value >>> 0;
    const lenBytes = lenRes.consumed;
    const headerLen = 1 + lenBytes; // SoF + LEN
    const totalFrameLen = headerLen + payloadLen + 2; // + CHK

    if (merged.length - sofIndex < totalFrameLen) {
      const missing = totalFrameLen - (merged.length - sofIndex);
      state = {
        partial: true,
        stage: missing > 2 ? 'payload' : 'chk',
        len: payloadLen,
        lenBytes,
        bytesNeeded: missing,
      };
      break; // incomplete frame
    }

    // We have a full frame candidate
    const frameEnd = sofIndex + totalFrameLen;
    const withoutChk = merged.subarray(sofIndex, frameEnd - 2);
    const rxChk = ((merged[frameEnd - 2] << 8) | merged[frameEnd - 1]) & 0xffff;
    const expChk = calcChecksum(withoutChk);

    if (rxChk !== expChk) {
      // Corrupt frame → discard this SoF and resync
      i = sofIndex + 1;
      continue;
    }

    // Extract payload
    const payloadStart = sofIndex + headerLen;
    const payloadEnd = payloadStart + payloadLen;
    // Ensure returned payloads are plain Uint8Array (not Buffer)
    const pl = merged.slice(payloadStart, payloadEnd);
    frames.push(Uint8Array.from(pl));

    // Advance to next
    i = frameEnd;
  }

  const rest = Uint8Array.from(merged.slice(i));
  if (!state.partial) state = { partial: false, stage: 'idle' };
  return { frames, rest, state };
}

function toUint8Array(buf: Buffer | Uint8Array): Uint8Array {
  // Buffer extends Uint8Array; a simple cast is sufficient and avoids TS narrowing issues
  return buf as Uint8Array;
}
