import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// Reads one named entry out of a zip archive (a Maven jar) in this process:
// no child process, no extraction to disk, and every read bounded. Only stored
// and deflated entries are understood; zip64 and encrypted entries are refused
// with a reason rather than guessed at.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_FIXED = 22;
const MAX_COMMENT = 0xffff;

/** Largest central directory the reader will load, in bytes. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;

export type JarEntryRead =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Read the entry `name` from the archive at `path`, never producing more than
 * `maxBytes` bytes. Never throws: an entry that is not in the archive is
 * `absent`, and everything else that stops the read is `failed` with its true
 * reason.
 *
 * @param path - The archive on disk.
 * @param name - The entry's full name inside the archive.
 * @param maxBytes - The most uncompressed bytes the caller will accept.
 */
export function readJarEntry(path: string, name: string, maxBytes: number): JarEntryRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    return failed(`the archive could not be opened (${codeOf(err)})`);
  }
  try {
    return readEntry(fd, name, maxBytes);
  } catch (err) {
    return failed(`the archive could not be read (${codeOf(err)})`);
  } finally {
    closeSync(fd);
  }
}

function failed(reason: string): JarEntryRead {
  return { kind: "failed", reason };
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
}

function readAt(fd: number, position: number, length: number): Buffer | null {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) return null;
    done += n;
  }
  return buffer;
}

function readEntry(fd: number, name: string, maxBytes: number): JarEntryRead {
  const size = fstatSync(fd).size;
  if (size < EOCD_FIXED) return failed("the archive is too short to be a zip file");

  const tailLength = Math.min(size, EOCD_FIXED + MAX_COMMENT);
  const tail = readAt(fd, size - tailLength, tailLength);
  if (tail === null) return failed("the archive ended while its end record was being read");
  let eocd = -1;
  for (let i = tail.length - EOCD_FIXED; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return failed("the archive has no end-of-central-directory record");

  const entries = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return failed("the archive uses zip64, which is not supported");
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    return failed(`the archive's central directory is larger than ${MAX_CENTRAL_DIRECTORY_BYTES} bytes`);
  }
  if (directoryOffset + directorySize > size) return failed("the archive's central directory lies outside the file");

  const directory = readAt(fd, directoryOffset, directorySize);
  if (directory === null) return failed("the archive ended inside its central directory");

  const wanted = Buffer.from(name, "utf8");
  let at = 0;
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      return failed("the archive's central directory is corrupt");
    }
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const compressed = directory.readUInt32LE(at + 20);
    const uncompressed = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const localOffset = directory.readUInt32LE(at + 42);
    const entryName = directory.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!entryName.equals(wanted)) continue;

    if ((flags & 1) !== 0) return failed(`${name} is encrypted, which is not supported`);
    if (method !== 0 && method !== 8) return failed(`${name} uses compression method ${method}, which is not supported`);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) return failed(`${name} uses zip64, which is not supported`);
    if (uncompressed > maxBytes) return failed(`${name} is ${uncompressed} bytes; the limit is ${maxBytes}`);
    if (compressed > maxBytes) return failed(`${name} is ${compressed} bytes compressed; the limit is ${maxBytes}`);

    const local = readAt(fd, localOffset, 30);
    if (local === null || local.readUInt32LE(0) !== LOCAL_SIGNATURE) return failed(`the local header of ${name} is corrupt`);
    const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataOffset + compressed > size) return failed(`${name} extends past the end of the archive`);
    const data = readAt(fd, dataOffset, compressed);
    if (data === null) return failed(`the archive ended inside ${name}`);

    let bytes: Buffer;
    if (method === 0) {
      bytes = data;
    } else {
      try {
        bytes = inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch {
        return failed(`${name} is corrupt or inflates past ${maxBytes} bytes`);
      }
    }
    if (bytes.length !== uncompressed) return failed(`${name} does not match the size its directory entry states`);
    return { kind: "ok", bytes };
  }
  return { kind: "absent" };
}
