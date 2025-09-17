const test = require('node:test');
const assert = require('node:assert/strict');

// Tests use the compiled JS output
const { encode, decode, calcChecksum } = require('../../dist/main/protocol/frame.js');

function toBuf(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

test('encode/decode roundtrip - small payload', () => {
  const payload = Uint8Array.from([1, 2, 3, 4, 5]);
  const frame = encode(payload);
  const { frames, rest, state } = decode(toBuf(frame));
  assert.equal(rest.length, 0);
  assert.equal(state.partial, false);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], payload);
});

test('streaming partial chunk - split in two', () => {
  const payload = Uint8Array.from([10, 20, 30, 40, 50, 60]);
  const frame = encode(payload);
  const split = Math.floor(frame.length / 2);
  const part1 = frame.slice(0, split);
  const part2 = frame.slice(split);

  const r1 = decode(toBuf(part1));
  assert.equal(r1.frames.length, 0);
  assert.ok(r1.state.partial);
  assert.ok(r1.rest.length > 0);

  const merged = Buffer.concat([toBuf(r1.rest), toBuf(part2)]);
  const r2 = decode(merged);
  assert.equal(r2.frames.length, 1);
  assert.deepEqual(r2.frames[0], payload);
  assert.equal(r2.rest.length, 0);
});

test('LEN multi-byte (>=128) enc/dec', () => {
  const len = 200;
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = i & 0xff;
  const frame = encode(payload);
  const r = decode(toBuf(frame));
  assert.equal(r.frames.length, 1);
  assert.deepEqual(r.frames[0], payload);
  assert.equal(r.rest.length, 0);
});

test('corrupted checksum frame is discarded, next valid frame parsed', () => {
  const goodPayload = Uint8Array.from([0x42, 0x43]);
  const goodFrame = encode(goodPayload);

  // Create a corrupted frame by flipping one payload byte
  const badPayload = Uint8Array.from([0x10, 0x20, 0x30]);
  const badFrame = encode(badPayload);
  const badCorrupted = badFrame.slice();
  // Flip a payload byte (after SoF + LEN)
  // Find start of payload: SoF(1) + LEN(varint). For small 3 bytes len, LEN is 1 byte.
  let lenBytes = 1; // for payload length 3, it will be 1 byte
  const payloadStart = 1 + lenBytes;
  badCorrupted[payloadStart] ^= 0xFF; // corrupt

  const stream = Buffer.concat([toBuf(badCorrupted), toBuf(goodFrame)]);
  const r = decode(stream);
  assert.equal(r.rest.length, 0);
  assert.equal(r.frames.length, 1);
  assert.deepEqual(r.frames[0], goodPayload);
});

test('empty payload enc/dec', () => {
  const payload = new Uint8Array(0);
  const frame = encode(payload);
  const r = decode(toBuf(frame));
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].length, 0);
  assert.equal(r.rest.length, 0);
});

test('partial in LEN (varint split) handled via rest merge', () => {
  const len = 200; // multi-byte varint
  const payload = new Uint8Array(len);
  const frame = encode(payload);
  // Locate boundary after SoF + first LEN byte
  const firstLenByteIndex = 1; // SoF at 0, first LEN at 1
  const split = firstLenByteIndex + 1; // after first LEN byte
  const part1 = frame.slice(0, split);
  const part2 = frame.slice(split);

  const r1 = decode(toBuf(part1));
  assert.equal(r1.frames.length, 0);
  assert.ok(r1.state.partial);
  assert.equal(r1.state.stage, 'len');

  const merged = Buffer.concat([toBuf(r1.rest), toBuf(part2)]);
  const r2 = decode(merged);
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].length, len);
  assert.equal(r2.rest.length, 0);
});

