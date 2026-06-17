import { strict as assert } from "node:assert";
import { test } from "node:test";

import { encodeMessage, LspFramingError, LspMessageDecoder } from "./lsp-framing.js";

function frame(json: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`, "utf8");
}

test("encodeMessage emits a Content-Length header sized in UTF-8 bytes", () => {
  const buf = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  const text = buf.toString("utf8");
  const payload = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  assert.equal(text, `Content-Length: ${payload.length}\r\n\r\n${payload}`);
});

test("encodeMessage counts bytes, not characters, for multi-byte payloads", () => {
  const buf = encodeMessage({ name: "ł" }); // 'ł' is 2 bytes in UTF-8
  const header = buf.toString("ascii").split("\r\n\r\n")[0];
  // {"name":"ł"} = 11 ASCII bytes + 1 extra byte for the 2-byte 'ł' = 13
  assert.equal(header, "Content-Length: 13");
});

test("encode → decode round-trips a message", () => {
  const decoder = new LspMessageDecoder();
  const out = decoder.push(encodeMessage({ jsonrpc: "2.0", id: 7, result: { ok: true } }));
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 7, result: { ok: true } }]);
});

test("decoder returns multiple messages delivered in one chunk", () => {
  const decoder = new LspMessageDecoder();
  const chunk = Buffer.concat([frame('{"id":1}'), frame('{"id":2}')]);
  assert.deepEqual(decoder.push(chunk), [{ id: 1 }, { id: 2 }]);
});

test("decoder reassembles a message split across chunks (header split)", () => {
  const decoder = new LspMessageDecoder();
  const full = frame('{"id":42}');
  const a = full.subarray(0, 8); // mid-header
  const b = full.subarray(8);
  assert.deepEqual(decoder.push(a), []);
  assert.deepEqual(decoder.push(b), [{ id: 42 }]);
});

test("decoder reassembles a message split across chunks (body split)", () => {
  const decoder = new LspMessageDecoder();
  const full = frame('{"hello":"world"}');
  const split = full.indexOf("\r\n\r\n") + 6; // a few bytes into the body
  assert.deepEqual(decoder.push(full.subarray(0, split)), []);
  assert.deepEqual(decoder.push(full.subarray(split)), [{ hello: "world" }]);
});

test("decoder holds a trailing partial frame until completed", () => {
  const decoder = new LspMessageDecoder();
  const chunk = Buffer.concat([frame('{"id":1}'), frame('{"id":2}').subarray(0, 10)]);
  assert.deepEqual(decoder.push(chunk), [{ id: 1 }]);
  assert.deepEqual(decoder.push(frame('{"id":2}').subarray(10)), [{ id: 2 }]);
});

test("decoder tolerates extra headers and case-insensitive Content-Length", () => {
  const decoder = new LspMessageDecoder();
  const json = '{"id":9}';
  const raw = Buffer.from(
    `content-length: ${json.length}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n${json}`,
    "utf8",
  );
  assert.deepEqual(decoder.push(raw), [{ id: 9 }]);
});

test("decoder throws LspFramingError on a missing Content-Length", () => {
  const decoder = new LspMessageDecoder();
  const raw = Buffer.from("X-Foo: bar\r\n\r\n{}", "utf8");
  assert.throws(() => decoder.push(raw), LspFramingError);
});

test("decoder throws LspFramingError on a non-numeric Content-Length", () => {
  const decoder = new LspMessageDecoder();
  const raw = Buffer.from("Content-Length: abc\r\n\r\n{}", "utf8");
  assert.throws(() => decoder.push(raw), LspFramingError);
});

test("decoder throws LspFramingError on a malformed JSON body", () => {
  const decoder = new LspMessageDecoder();
  assert.throws(() => decoder.push(frame("{not json}")), LspFramingError);
});
