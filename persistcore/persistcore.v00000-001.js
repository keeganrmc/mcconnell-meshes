// ============================================================================
// PERSISTCORE v00000-001 — crash-safe SNAPSHOT+JOURNAL autosave engine.
// Twin module: canonical copy here; Rendre-web carries a hand-pasted inline
// twin in rendre.html (single-file discipline forbids an import there).
// Any behavior change must be ported to BOTH copies by hand. Kept under
// ~300 lines so twinning stays honest (spec sec 3.3).
//
// Storage is backend-agnostic: the caller supplies writeSlot/readSlot (OPFS
// for Pgon's binary BANK bytes, IndexedDB for Rendre-web's small JSON
// settings object) plus checksumOf/getSnapshot for that payload type. This
// module owns slot rotation, verify-before-promote, the journal, lifecycle
// flush, and recovery — it never interprets what a payload or a journal
// record means.
// ============================================================================

// ⚠ `seed` MAKES THIS FOLDABLE. FNV-1a is a rolling hash, so fnv1a32(chunkB, fnv1a32(chunkA)) ===
// fnv1a32(concat(A, B)). A caller can stream a slot and fold, holding one chunk at a time instead
// of a second buffer the size of the snapshot (~332 MB on a large scene). Called with one argument
// it is plain FNV-1a, so checksums already on disk still match.
export function fnv1a32(input, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  if (typeof input === 'string') {
    for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  } else {
    for (let i = 0; i < input.length; i++) { h ^= input[i]; h = Math.imul(h, 0x01000193); }
  }
  return h >>> 0;
}

// Cached per dbName — recover()/writeSnapshotNow() each make several sequential get/set calls,
// and reopening indexedDB.open() for every one measurably slows the recovery path against a
// caller's own restore-in-progress window, so one connection is reused for the lifetime of the
// page.
const _pcDbCache = new Map();
function pcOpenDb(dbName) {
  if (_pcDbCache.has(dbName)) return _pcDbCache.get(dbName);
  const p = new Promise((resolve, reject) => {
    const rq = indexedDB.open(dbName, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { autoIncrement: true });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => { _pcDbCache.delete(dbName); reject(rq.error); };
  });
  _pcDbCache.set(dbName, p);
  return p;
}
async function pcKvGet(dbName, key) {
  const db = await pcOpenDb(dbName);
  return new Promise((res, rej) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
async function pcKvSet(dbName, key, val) {
  const db = await pcOpenDb(dbName);
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
  });
}
async function pcJournalAppend(dbName, record) {
  const db = await pcOpenDb(dbName);
  return new Promise((res, rej) => {
    const tx = db.transaction('journal', 'readwrite');
    const rq = tx.objectStore('journal').add(record);
    let seq = null;
    rq.onsuccess = () => { seq = rq.result; }; // the auto-assigned seq, handed back at commit
    // Durable at the transaction's completion, not the request's success: a transaction can
    // still abort after its request has succeeded (quota, a close, an abort), and a promise
    // resolved on the request has already said "written" by then.
    tx.oncomplete = () => res(seq);
    tx.onabort = () => rej(tx.error || new Error('journal transaction aborted'));
    tx.onerror = () => rej(tx.error);
  });
}
async function pcJournalAfter(dbName, seq) {
  const db = await pcOpenDb(dbName);
  return new Promise((res, rej) => {
    const out = [];
    const range = seq == null ? undefined : IDBKeyRange.lowerBound(seq, true);
    const rq = db.transaction('journal', 'readonly').objectStore('journal').openCursor(range);
    rq.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return res(out);
      out.push({ seq: cur.key, t: cur.value.t, size: cur.value.size, checksum: cur.value.checksum, data: cur.value.data });
      cur.continue();
    };
    rq.onerror = () => rej(rq.error);
  });
}
async function pcJournalCompact(dbName, throughSeq) {
  if (throughSeq == null) return true;
  const db = await pcOpenDb(dbName);
  return new Promise((res, rej) => {
    const tx = db.transaction('journal', 'readwrite');
    tx.objectStore('journal').delete(IDBKeyRange.upperBound(throughSeq));
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
  });
}
async function pcJournalStats(dbName) {
  const db = await pcOpenDb(dbName);
  return new Promise((res, rej) => {
    let count = 0, bytes = 0, lastSeq = null;
    const rq = db.transaction('journal', 'readonly').objectStore('journal').openCursor();
    rq.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return res({ count, bytes, lastSeq });
      count++; bytes += cur.value.size || 0; lastSeq = cur.key;
      cur.continue();
    };
    rq.onerror = () => rej(rq.error);
  });
}

// opts: { ns, writeSlot(slot,payload), readSlot(slot)=>payload, checksumOf(payload),
//   checksumSlot(slot)=>hash|null  OPTIONAL — verify without materialising the slot; null if absent/empty,
//         getSnapshot()=>payload, isDirty()=>bool, snapshotIntervalMs, journalCap,
//         journalByteCap, quietTell(kind) }
export function createPersistCore(opts) {
  const dbName = opts.ns + '-persist';
  const { writeSlot, readSlot, checksumOf, checksumSlot, getSnapshot, isDirty, quietTell, onSnapshotWritten } = opts;
  const snapshotIntervalMs = opts.snapshotIntervalMs || 120000;
  const journalCap = opts.journalCap || 500;
  const journalByteCap = opts.journalByteCap || 2_000_000;
  let writing = false;
  // ⚠⚠⚠ A CONCURRENT "SNAPSHOT NOW" MUST NOT BE DROPPED; A DROPPED ONE IS A LOST EDIT. The timer and
  // gestures both ask, and the overlap is the case that matters: Clear asks for a snapshot
  // immediately, and if an earlier write is still in flight, a dropped request leaves the PRE-CLEAR
  // scene on disk and the removed objects come back on reload.
  // ⚠ REQUEUED, NOT QUEUED DEEP. One pending flag, not a list: every caller wants the same thing —
  // the CURRENT state on disk — so N requests during one write collapse into a single follow-up, and
  // that follow-up reads getSnapshot() fresh.
  let pending = false;

  // ⚠⚠ THE REQUEUED WRITE MUST IGNORE `isDirty`. The write it queued behind calls onSnapshotWritten,
  // which is how the caller clears its own dirty flag — so by the time the follow-up runs,
  // `isDirty()` is false and a dirty-gated follow-up returns without writing: a Clear requested
  // during an earlier write silently does nothing and the pre-Clear scene returns after a reload.
  // `force` is passed only from the requeue, so a timer tick over a clean scene still costs nothing.
  async function writeSnapshotNow(force = false) {
    if (writing) { pending = true; return false; }
    if (!force && isDirty && !isDirty()) return false;
    writing = true;
    try {
      const ptr = (await pcKvGet(dbName, 'ptr')) || { active: 'B' }; // first-ever write lands in 'A'
      const target = ptr.active === 'A' ? 'B' : 'A';
      // ⚠⚠ THE BASELINE IS READ BEFORE THE STATE IS CAPTURED, NEVER AFTER THE WRITE. journalSeqAtSnapshot
      // names the last record the snapshot already contains; recover() replays only what follows it.
      // getSnapshot is synchronous, and no task can run between this read's resolution and the
      // capture, so the two agree exactly; a record appended while the slot writes is after the
      // baseline and replays on top. Read after writeSlot it counts every record appended DURING the
      // write, and a stroke landed while Clear's snapshot was writing sits behind the baseline of a
      // snapshot that does not contain it — the cleared scene comes back as the last state.
      const stats = await pcJournalStats(dbName);
      const payload = await getSnapshot();
      await writeSlot(target, payload);
      // WRITE-THEN-SWAP: verify by an independent re-read before the pointer ever
      // moves, so an interrupted write can only ever strand the slot NOT pointed to.
      const sum = checksumOf(payload);
      // ⚠⚠ THE RE-READ IS STREAMED WHEN THE CALLER CAN STREAM IT. `readSlot(target)` +
      // `checksumOf(readBack)` pulls the ENTIRE slot back into memory only to hash it — a second buffer
      // the size of the snapshot (~332 MB measured) while the first copy is still alive. `checksumSlot`
      // folds the file in chunks; fnv1a32 takes a seed so the fold is byte-identical to hashing the whole
      // buffer. A MISSING or EMPTY slot must still read as a mismatch, which is why both paths yield null
      // rather than a hash.
      const readSum = checksumSlot
        ? await checksumSlot(target)
        : await (async () => { const rb = await readSlot(target); return rb == null ? null : checksumOf(rb); })();
      if (readSum == null || readSum !== sum) throw new Error('snapshot verify mismatch');
      await pcKvSet(dbName, 'ptr', {
        active: target, gen: (ptr.gen || 0) + 1,
        // ⚠ WHEN, NOT JUST WHICH. A caller that has just thrown the document away needs to know
        // whether the generation on disk predates that — the pointer alone cannot say, and a
        // recovery that cannot tell hands back the scene the person deleted on purpose.
        writtenAt: Date.now(),
        journalSeqAtSnapshot: stats.lastSeq, checksum: sum,
        // keep the OUTGOING generation as the fallback — a corrupt/short-write of
        // `target` above already bailed before this point, so this is genuinely
        // the previous GOOD generation, not just "the other slot".
        prevActive: ptr.checksum != null ? ptr.active : null,
        prevChecksum: ptr.checksum, prevJournalSeqAtSnapshot: ptr.journalSeqAtSnapshot,
        prevWrittenAt: ptr.writtenAt,
      });
      // ⚠ Compact only through the OUTGOING generation's OWN baseline (ptr.journalSeqAtSnapshot, about
      // to become the new prevJournalSeqAtSnapshot above), NOT this snapshot's baseline (stats.lastSeq).
      // Compacting through stats.lastSeq deletes exactly the journal range the prevActive fallback
      // depends on — if the new slot is later found unreadable, recover() falls back to prevActive and
      // replays from prevJournalSeqAtSnapshot, and those records would be gone. The cost is one
      // generation's worth of retained journal; the case it covers (P3, iPad Safari backgrounding
      // killing a write mid-flight) has no other fallback. A first write has no prior generation
      // (ptr.journalSeqAtSnapshot is undefined), so it compacts through its own baseline.
      const compactThrough = ptr.journalSeqAtSnapshot != null ? ptr.journalSeqAtSnapshot : stats.lastSeq;
      if (compactThrough != null) await pcJournalCompact(dbName, compactThrough);
      if (quietTell) quietTell('commit');
      if (onSnapshotWritten) onSnapshotWritten(); // lets the caller clear its own dirty flag
      return true;
    } catch (err) {
      console.warn('persistcore snapshot failed (non-fatal — next timer/gesture retries):', err);
      if (quietTell) quietTell('error');
      return false;
    } finally {
      writing = false;
      // Anything asked for while that was in flight gets its write now, against fresh state.
      if (pending) { pending = false; writeSnapshotNow(true); }
    }
  }

  // Appends not yet on disk. A caller that must know its records have landed — a tab about to be
  // killed — waits for zero rather than for a guessed number of milliseconds.
  let appendsInFlight = 0;
  async function appendJournal(record) {
    // Deliberately does NOT wait on (or trigger) a snapshot before appending — a
    // journal append must stay fast and unconditional (spec sec 1.2: "the PRIMARY
    // mechanism"), even for the very first gesture of a brand-new session, before
    // any snapshot generation exists yet. recover() below handles that "no snapshot
    // at all" case by replaying onto the caller's own default boot state instead of
    // depending on one.
    appendsInFlight++;
    try {
      const data = JSON.stringify(record);
      await pcJournalAppend(dbName, { t: Date.now(), size: data.length, checksum: fnv1a32(data), data });
      if (quietTell) quietTell('commit');
      const stats = await pcJournalStats(dbName);
      if (stats.count >= journalCap || stats.bytes >= journalByteCap) writeSnapshotNow(); // early compaction, spec sec 1.6
      return true;
    } catch (err) {
      // The record is not on disk. The tell shows it, as it does for a failed snapshot; the next
      // snapshot carries the state the record described.
      console.warn('persistcore journal append failed (non-fatal):', err);
      if (quietTell) quietTell('error');
      return false;
    }
    finally { appendsInFlight--; }
  }
  const journalInFlight = () => appendsInFlight;

  async function recover() {
    const ptr = await pcKvGet(dbName, 'ptr');
    if (!ptr) {
      // No snapshot generation has EVER landed — replay the whole journal (if any)
      // onto whatever deterministic default state the caller already booted into,
      // rather than treating "no snapshot yet" as "nothing to recover."
      const raw = await pcJournalAfter(dbName, null);
      const journalRecords = [];
      for (const r of raw) {
        if (fnv1a32(r.data) !== r.checksum) break;
        try { journalRecords.push(JSON.parse(r.data)); } catch (_) { break; }
      }
      return { snapshot: null, journalRecords, recoveredFromFallbackSlot: false, writtenAt: null };
    }
    const candidates = [
      { slot: ptr.active, checksum: ptr.checksum, journalSeqAtSnapshot: ptr.journalSeqAtSnapshot, writtenAt: ptr.writtenAt },
      ptr.prevActive != null ? { slot: ptr.prevActive, checksum: ptr.prevChecksum, journalSeqAtSnapshot: ptr.prevJournalSeqAtSnapshot, writtenAt: ptr.prevWrittenAt } : null,
    ].filter(Boolean);
    let snapshot = null, chosenSeq = null, usedFallback = false, chosenWrittenAt = null;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const payload = await readSlot(c.slot);
        if (payload != null && checksumOf(payload) === c.checksum) { snapshot = payload; chosenSeq = c.journalSeqAtSnapshot; chosenWrittenAt = c.writtenAt != null ? c.writtenAt : 0; usedFallback = i > 0; break; }
      } catch (_) { /* try the next candidate */ }
    }
    let journalRecords = [];
    if (snapshot) {
      const raw = await pcJournalAfter(dbName, chosenSeq);
      for (const r of raw) {
        if (fnv1a32(r.data) !== r.checksum) break; // truncate at first bad record, spec sec 1.4
        try { journalRecords.push(JSON.parse(r.data)); } catch (_) { break; }
      }
    }
    return { snapshot, journalRecords, recoveredFromFallbackSlot: usedFallback, writtenAt: chosenWrittenAt };
  }

  function installLifecycleFlush(flushFn) {
    // visibilitychange+pagehide catch almost every death; beforeunload is
    // unreliable on iPad Safari and is NOT relied on here (spec sec 1.5).
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushFn(); });
    window.addEventListener('pagehide', () => { flushFn(); });
  }
  async function requestPersistence() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) { /* quiet, no nag */ }
  }
  const timer = setInterval(() => { if (!isDirty || isDirty()) writeSnapshotNow(); }, snapshotIntervalMs);

  // Exposes the raw pointer record so a caller can offer "open the OTHER generation"
  // as the rare-corruption escape hatch (spec sec 2.3) without persistcore needing to
  // know what a manual-choice UI looks like.
  async function peekPointer() { return (await pcKvGet(dbName, 'ptr')) || null; }

  return { appendJournal, journalInFlight, writeSnapshotNow, recover, peekPointer, installLifecycleFlush, requestPersistence, destroy: () => clearInterval(timer) };
}
