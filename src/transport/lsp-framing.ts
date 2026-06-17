// LSP base-protocol message framing.
//
// The Language Server Protocol frames each JSON-RPC message with HTTP-like
// headers — `Content-Length: <byteLength>\r\n\r\n<utf8-json>` — NOT the
// newline-delimited framing MCP uses on its own stdio transport. This module
// is the pure codec for that base protocol: encode an object to a framed
// Buffer, and incrementally decode a byte stream back into JSON values.
//
// Kept dependency-free and side-effect-free so the framing logic is unit
// tested in isolation from any child process. The process/lifecycle concerns
// live in lsp-client.ts.

const HEADER_TERMINATOR = "\r\n\r\n";
const CONTENT_LENGTH_PREFIX = "content-length:";

/** Raised when the incoming byte stream violates the base-protocol framing. */
export class LspFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspFramingError";
  }
}

/**
 * Encode a JSON-RPC message object as an LSP base-protocol frame.
 *
 * Content-Length is the UTF-8 *byte* length of the payload, not its character
 * count — multi-byte identifiers in params must not desynchronise the peer.
 */
export function encodeMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}${HEADER_TERMINATOR}`, "ascii");
  return Buffer.concat([header, payload]);
}

/**
 * Streaming decoder for LSP base-protocol frames.
 *
 * Feed it raw stdout chunks via `push`; it buffers partial frames across
 * chunk boundaries and returns every *complete* message it can now parse.
 * A single chunk may carry zero, one, or several messages, and a message
 * may straddle any number of chunks — both are handled.
 *
 * Stateful (holds the unconsumed byte tail), so one decoder instance belongs
 * to exactly one stream.
 */
export class LspMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) break; // headers not fully received yet

      const headerBlock = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(headerBlock);
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;

      if (this.buffer.length < bodyStart + contentLength) break; // body still incomplete

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      messages.push(parseJsonBody(body));
    }

    return messages;
  }
}

function parseContentLength(headerBlock: string): number {
  for (const line of headerBlock.split("\r\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    if (line.slice(0, sep).trim().toLowerCase() !== CONTENT_LENGTH_PREFIX.slice(0, -1)) continue;
    const value = Number(line.slice(sep + 1).trim());
    if (!Number.isInteger(value) || value < 0) {
      throw new LspFramingError(`Malformed Content-Length header: ${line.trim()}`);
    }
    return value;
  }
  throw new LspFramingError("LSP frame is missing a Content-Length header");
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (cause) {
    throw new LspFramingError("LSP frame body is not valid JSON");
  }
}
