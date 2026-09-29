# Append Log

A crash-safe, append-only record log for Node.js. Zero dependencies.

```js
import { AppendLog } from 'append-log';

const log = new AppendLog('./data');
log.append(new Uint8Array([1, 2, 3]));
log.append(new Uint8Array([4, 5]));
log.close();

for (const record of log.iterate()) {
  console.log(record); // Uint8Array(3) [1, 2, 3], then Uint8Array(2) [4, 5]
}
```

## Why

This library exists for the case where you need every acknowledged write to
survive a power loss, and you can afford an `fsync` per append — write-ahead
logs, event journals, replication queues. Each `append()` writes a 4-byte
big-endian length prefix followed by the payload, then calls `fsync` before
returning. That is the entire design.

The trade-off is throughput: one `fsync` per record is slow. If you need high
write throughput and can tolerate losing the last few records on crash, use a
buffered writer instead.

## Edge cases

If the process crashes mid-append, the log will end with a partial record —
either a truncated header or a body shorter than the length prefix declares.
`iterate()` detects this and stops at the last complete record; the partial
tail is silently skipped. It is not deleted from disk. A subsequent `append()`
will write after the partial bytes, leaving a dead region in the file. This is
acceptable for a WAL that is periodically compacted; if you need to reclaim
that space, copy live records to a new log and replace the file.

The log file is opened with `O_APPEND`, so writes from multiple `AppendLog`
instances pointing at the same file will not interleave at the byte level.
Records larger than 4 GiB are rejected.
