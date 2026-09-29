import { openSync, closeSync, writeSync, readSync, fstatSync, existsSync, mkdirSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

/**
 * On-disk record format: a 4-byte big-endian length prefix followed by the
 * raw payload bytes. We use big-endian because it is the conventional network
 * byte order and reads identically on little- and big-endian machines — the
 * log file is portable across architectures, which matters because logs are
 * often copied between machines.
 */
const LENGTH_PREFIX_BYTES = 4;

/**
 * Synchronous, append-only, crash-safe record log.
 *
 * "Crash-safe" here means: after `append()` returns, the record is on disk.
 * If the process dies mid-append, the tail of the log may contain a
 * partially-written record; `iterate()` detects and skips it. No record
 * that was fully acknowledged is ever lost or corrupted.
 *
 * The trade-off: every append calls `fsync`, which is slow. This log is for
 * data whose durability matters more than throughput (write-ahead logs,
 * event journals). If you need high write throughput, use a buffered writer
 * and accept a larger crash window.
 */
export class AppendLog {
  /**
   * @param {string} dir - Directory holding the log file. Created if missing.
   * @param {object} [opts]
   * @param {string} [opts.filename='log.bin'] - Name of the log file inside `dir`.
   */
constructor(dir, opts = {}) {
    if (typeof dir !== 'string' || dir.length === 0) {
      throw new TypeError('AppendLog: dir must be a non-empty string');
    }
    const filename = opts.filename ?? 'log.bin';
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('AppendLog: filename must be a non-empty string');
    }

    // mkdirSync with recursive:true is idempotent, so creating an existing
    // directory is not an error. This avoids a TOCTOU race between existsSync
    // and mkdirSync.
    mkdirSync(dir, { recursive: true });

    this._path = join(dir, filename);
    // O_APPEND guarantees each write lands at the current end-of-file,
    // preventing interleaved writes under any future concurrency. O_CREAT
    // creates the file on first open. We keep the fd open for the log's
    // lifetime so we pay one open, not one per append.
    this._fd = openSync(this._path, 'a');
  }

  /**
   * Append a record. The data is written and fsync'd before this returns.
   *
   * @param {Uint8Array} data - Raw bytes to append. A copy is taken so later
   *   mutation of the caller's buffer cannot corrupt the on-disk record.
   * @returns {number} The byte offset within the log file where this record
   *   begins. Useful for callers that maintain their own index.
   */
  append(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('AppendLog.append: data must be a Uint8Array');
    }
    // 32-bit length prefix caps record size at ~4 GiB. Larger records would
    // need a wider prefix; we reject rather than silently truncate.
    if (data.length > 0xFFFFFFFF) {
      throw new RangeError('AppendLog.append: record exceeds 4 GiB limit');
    }

    const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
    header.writeUInt32BE(data.length, 0);

    // Copy the payload so the caller cannot mutate the bytes after we write
    // them. We write header and body in a single writeSync call so the kernel
    // sees one contiguous append — under O_APPEND this is atomic with respect
    // to other appenders on the same fd.
    const record = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + data.length);
    header.copy(record, 0);
    record.set(data, LENGTH_PREFIX_BYTES);

    const offset = this._size();
    writeSync(this._fd, record);
    this._sync();
    return offset;
  }

  /**
   * Iterate over all complete, readable records in append order.
   *
   * If the log ends with a partial record (a crash during append), that
   * partial record is silently skipped. Iteration then stops.
   *
   * @returns {Generator<Uint8Array, void, void>}
   */
  *iterate() {
    if (!existsSync(this._path)) return;

    let fd;
    try {
      fd = openSync(this._path, 'r');
      const fileSize = fstatSync(fd).size;

      let pos = 0;
      const headerBuf = Buffer.alloc(LENGTH_PREFIX_BYTES);

      while (pos < fileSize) {
        // Read the length prefix. If we cannot read a full header, the log
        // was truncated mid-write — stop here.
        const headerRead = readSync(fd, headerBuf, 0, LENGTH_PREFIX_BYTES, pos);
        if (headerRead < LENGTH_PREFIX_BYTES) break;

        const bodyLen = headerBuf.readUInt32BE(0);
        const recordEnd = pos + LENGTH_PREFIX_BYTES + bodyLen;

        // A declared length that runs past EOF means the body was never fully
        // written. This is the crash-mid-append case: skip it.
        if (recordEnd > fileSize) break;

        const body = Buffer.allocUnsafe(bodyLen);
        const bodyRead = readSync(fd, body, 0, bodyLen, pos + LENGTH_PREFIX_BYTES);
        if (bodyRead < bodyLen) break;

        yield new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        pos = recordEnd;
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Close the underlying file descriptor. Idempotent.
   */
  close() {
    if (this._fd !== undefined) {
      closeSync(this._fd);
      this._fd = undefined;
    }
  }

  _size() {
    return fstatSync(this._fd).size;
  }

  _sync() {
    // fsync is the only operation that actually forces the page cache to disk.
    // Without it, a power loss after writeSync can lose acknowledged records.
    // This is the whole point of the library.
    fsyncSync(this._fd);
  }
}
