import { StringDecoder } from "node:string_decoder";

// Newline-delimited JSON (NDJSON) message framing.
//
// The exeris-kernel-diagnostics-cli speaks NDJSON over stdio: one JSON object
// per line on stdin (requests) and stdout (responses), UTF-8, '\n'-terminated.
// This is the framing the KernelDiagnostics RFC / ADR-033 pin — distinct from
// the LSP base-protocol Content-Length framing (see lsp-framing.ts), and the
// CLI carries NO id field: it is stateless, emitting exactly one response line
// per request line, in order (the adapter correlates them FIFO).
//
// Pure codec, dependency-free and side-effect-free, so it is unit-tested in
// isolation from any child process. Lifecycle concerns live in kernel-adapter.ts.

/** Raised when an incoming line is not valid JSON. */
export class NdjsonFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NdjsonFramingError";
  }
}

/** Encode a message object as a single NDJSON line (trailing '\n'). */
export function encodeLine(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

/**
 * Streaming decoder for NDJSON.
 *
 * Feed it raw stdout chunks via `push`; it returns every COMPLETE line it can
 * now parse and buffers a partial trailing line across chunk boundaries. A
 * single chunk may carry zero, one, or several lines, and a line may straddle
 * any number of chunks — including a split mid-UTF-8-sequence, which the
 * StringDecoder reassembles correctly rather than corrupting.
 *
 * Blank lines (and a bare '\r' from CRLF) are skipped, not surfaced as parse
 * errors — a JVM stdio path can emit a stray newline. A non-blank line that is
 * not valid JSON throws NdjsonFramingError.
 *
 * Stateful (holds the unconsumed tail), so one decoder belongs to one stream.
 */
export class NdjsonDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer): unknown[] {
    this.buffer += this.decoder.write(chunk);
    const messages: unknown[] = [];

    for (let newline = this.buffer.indexOf("\n"); newline !== -1; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        messages.push(parseLine(line));
      }
    }

    return messages;
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new NdjsonFramingError(`NDJSON line is not valid JSON: ${truncate(line)}`);
  }
}

function truncate(line: string): string {
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
