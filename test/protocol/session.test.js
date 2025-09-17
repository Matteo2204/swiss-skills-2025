const test = require('node:test');
const assert = require('node:assert/strict');

const { Session, calcMAC, BYPASS_CONST } = require('../../dist/main/protocol/session.js');

test('symmetric key derivation (both sides match)', () => {
  const a = new Session();
  const b = new Session();

  const helloA = a.beginHandshake();
  const helloB = b.beginHandshake();

  // Exchange
  b.acceptChallenge(helloA);
  a.acceptChallenge(helloB);

  const ka = a.deriveKeys();
  const kb = b.deriveKeys();

  assert.equal(Buffer.compare(ka.txKey, kb.txKey), 0);
  assert.equal(Buffer.compare(ka.rxKey, kb.rxKey), 0);
});

test('deterministic MAC and bypass', () => {
  const s = new Session();
  const hello = s.beginHandshake();
  s.acceptChallenge(hello); // loopback to get a shared secret
  const { txKey } = s.deriveKeys();

  const payload = Buffer.from('abcd', 'utf8');
  const m1 = s.calcMAC(payload, txKey);
  const m2 = s.calcMAC(payload, txKey);
  assert.equal(m1, m2);
  assert.equal(m1 >>> 0, m1); // unsigned 32-bit

  s.useBypass(true);
  const mBypass = s.calcMAC(payload, txKey);
  assert.equal(mBypass >>> 0, BYPASS_CONST >>> 0);
});

test('standalone calcMAC equals session calcMAC (no bypass)', () => {
  const s = new Session();
  const hello = s.beginHandshake();
  s.acceptChallenge(hello);
  const { txKey } = s.deriveKeys();
  const payload = new Uint8Array([1,2,3,4,5,6,7,8,9]);
  const a = s.calcMAC(payload, txKey);
  const b = calcMAC(payload, txKey);
  assert.equal(a, b);
});

