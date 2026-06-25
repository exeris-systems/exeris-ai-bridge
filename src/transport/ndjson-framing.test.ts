import { strict as assert } from "node:assert";
import { test } from "node:test";

import { encodeLine, NdjsonDecoder, NdjsonFramingError } from "./ndjson-framing.js";

test("encodeLine emits compact JSON followed by a single newline", () => {
  const buf = encodeLine({ method: "listProviders" });
  assert.equal(buf.toString("utf8"), '{"method":"listProviders"}\n');
});

test("decoder returns multiple messages delivered in one chunk", () => {
  const decoder = new NdjsonDecoder();
  const out = decoder.push(Buffer.from('{"a":1}\n{"b":2}\n', "utf8"));
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("decoder reassembles a message split across chunks", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"hel', "utf8")), []);
  assert.deepEqual(decoder.push(Buffer.from('lo":"world"}\n', "utf8")), [{ hello: "world" }]);
});

test("decoder holds a trailing partial line until its newline arrives", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"x":1}\n{"y"', "utf8")), [{ x: 1 }]);
  assert.deepEqual(decoder.push(Buffer.from(":2}\n", "utf8")), [{ y: 2 }]);
});

test("decoder skips blank lines and a bare CR from CRLF framing", () => {
  const decoder = new NdjsonDecoder();
  const out = decoder.push(Buffer.from('\n{"a":1}\r\n\n{"b":2}\n', "utf8"));
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("decoder reassembles a multi-byte UTF-8 character split across chunks", () => {
  const decoder = new NdjsonDecoder();
  // '€' is 0xE2 0x82 0xAC — split the 3 bytes across two chunks.
  const line = Buffer.from('{"sym":"€"}\n', "utf8");
  const cut = line.indexOf(0x82); // mid-euro byte boundary
  assert.deepEqual(decoder.push(line.subarray(0, cut)), []);
  assert.deepEqual(decoder.push(line.subarray(cut)), [{ sym: "€" }]);
});

test("decoder throws NdjsonFramingError on a non-blank invalid JSON line", () => {
  const decoder = new NdjsonDecoder();
  assert.throws(() => decoder.push(Buffer.from("not json at all\n", "utf8")), NdjsonFramingError);
});
