/*
 * Timmy website chat: the bot check's work.
 *
 * Before the first message of a conversation, the chat window proves it did a small piece of work: it finds a
 * number n such that the SHA-256 hash of "challenge:n" starts with a given number of zero bits. The server
 * signed the challenge and checks the answer with one hash. Each try here is one hash, so the work is about
 * 2^bits tries on average, and it is cut off after many times that so it can never run on and on.
 *
 * Normally this file runs as a Web Worker, so the chat stays responsive while it works: it is sent
 * { challenge, bits } and answers { answer } (null if it gave up). Loaded as a plain script in the frame, it
 * offers the same work to be done in small pieces, for a browser that won't start a worker.
 * Plain JavaScript, no dependencies.
 */
(function (scope) {
  'use strict';

  var K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  var START = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  var W = new Int32Array(64);

  /** One round of SHA-256 over the 64 bytes of `bytes` starting at `at`, into the running hash `h`. */
  function compress(h, bytes, at) {
    var i, j, x, y;
    for (i = 0; i < 16; i++) {
      j = at + i * 4;
      W[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (i = 16; i < 64; i++) {
      x = W[i - 15];
      y = W[i - 2];
      W[i] = (W[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7], t1, t2;
    for (i = 0; i < 64; i++) {
      t1 = (k + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + k) | 0;
  }

  /**
   * Returns a function that tries `count` numbers from `from` and gives back the first that solves the
   * challenge (as text), or null. The part of the hash that only depends on the challenge is worked out once.
   */
  function solver(challenge, bits) {
    if (typeof challenge !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(challenge)) return null;
    var prefix = challenge + ':';
    var full = Math.floor(prefix.length / 64) * 64;
    var head = new Uint8Array(full);
    var i;
    for (i = 0; i < full; i++) head[i] = prefix.charCodeAt(i);
    var mid = new Int32Array(START);
    for (i = 0; i < full; i += 64) compress(mid, head, i);
    var rest = prefix.length - full;
    var tail = new Uint8Array(128);
    for (i = 0; i < rest; i++) tail[i] = prefix.charCodeAt(full + i);
    var h = new Int32Array(8);
    return function (from, count) {
      for (var n = from; n < from + count; n++) {
        var digits = String(n);
        var size = rest + digits.length;
        for (i = 0; i < digits.length; i++) tail[rest + i] = digits.charCodeAt(i);
        tail[size] = 0x80;
        var end = size + 9 <= 64 ? 64 : 128;
        for (i = size + 1; i < end - 4; i++) tail[i] = 0;
        var length = (full + size) * 8;
        tail[end - 4] = (length >>> 24) & 255;
        tail[end - 3] = (length >>> 16) & 255;
        tail[end - 2] = (length >>> 8) & 255;
        tail[end - 1] = length & 255;
        h.set(mid);
        compress(h, tail, 0);
        if (end === 128) compress(h, tail, 64);
        var zeros = Math.clz32(h[0]);
        if (zeros === 32) zeros += Math.clz32(h[1]);
        if (zeros >= bits) return digits;
      }
      return null;
    };
  }

  /** The most tries before giving up: far beyond what any challenge needs on average. */
  function most(bits) {
    return Math.min(Math.pow(2, Math.min(bits, 24) + 6), 1e9);
  }

  var api = { solver: solver, most: most };

  if (typeof scope.importScripts === 'function') {
    // As a worker: one challenge in, one answer out.
    scope.onmessage = function (event) {
      var d = event.data || {};
      var bits = typeof d.bits === 'number' && d.bits >= 0 && d.bits <= 24 ? d.bits : 24;
      var run = solver(d.challenge, bits);
      scope.postMessage({ answer: run ? run(0, most(bits)) : null });
    };
  } else {
    scope.timmyChatWork = api;
  }
})(self);
