# ADR 004 · Vector store for semantic memory

- **Status:** Proposed (waiting for the owner)
- **Plan:** [07 Memory](../07-memory-upgrade.md) · roadmap open decision 4 in [37](../37-execution-roadmap-and-risks.md) · contract `MemoryItem.embeddingId` in [38](../38-shared-data-contracts.md)
- **Queue:** written by Q37; Q38 (semantic recall) only starts once the line below is filled
- **Date checked:** 2026-11-02
- **Decision:**

## Context

Memory today is one local SQLite file (`bridge/memory.mjs`, using `node:sqlite`, no dependency)
with keyword search over FTS5. Plan 07 phase 1 adds local embeddings and hybrid keyword + vector
recall, with a target of Recall@5 ≥ 90 % on a paraphrase test set.

What this store has to respect, from the plans and the code:

- **Forget must really forget.** An embedding can reveal the text it came from. `memory.mjs` runs
  `PRAGMA secure_delete = ON`, and plan 07 requires "forget everything about X" to cascade through
  all layers. So the vector must be erased in the same step as the memory, including from any index.
- **Scopes are a safety boundary.** Search has to stay inside `personal` or one project, and later
  per-person (plan 01), so filtering must happen before results exist, not after.
- **Vault items are never embedded or auto-recalled** (plan 07).
- **Local only.** Embeddings and the index stay on the machine.
- **The Windows installer is the product.** `scripts/package.mjs` copies the running `node.exe` and
  runs `npm install --omit=dev` in the stage, so anything native must have a Windows x64 binary that
  lands in the stage and loads under the bundled Node.
- **Voice latency.** The bridge is one Node process and `node:sqlite` is synchronous, so slow search
  blocks everything else unless moved to a worker.

### How much data

Assumption, not a measurement: 40 messages a day for five years is about 73,000 rows. Saved
memories and journal events are far fewer, and search is limited to one scope, so a normal search
covers hundreds to low thousands of vectors, and the worst case is around 100,000.

## Measurements for this record

Run on 2026-11-02 in the cloud sandbox: Node 22.23.4, SQLite 3.53.4, 2 vCPU Xeon 2.1 GHz, random
unit vectors, 384 dimensions, stored as `Float32` BLOBs, loaded into one `Float32Array`, top 5 by
dot product in plain JavaScript on one thread.

| Vectors | Search p50 | Search p95 | Load from SQLite | File size | Memory |
|---|---:|---:|---:|---:|---:|
| 1,000 | 0.5 ms | 0.6 ms | 3 ms | 2 MB | 2 MB |
| 10,000 | 7 ms | 10 ms | 41 ms | 21 MB | 15 MB |
| 50,000 | 28 ms | 35 ms | 256 ms | 103 MB | 77 MB |
| 100,000 | 109 ms | 158 ms | 415 ms | 205 MB | 154 MB |

These are small-sample numbers from a shared machine, not the owner's PC. Q38 should repeat them there.

**Not measured:** sqlite-vec and LanceDB. The npm registry was blocked for this run, so neither was
installed. Their entries below come from documentation, not from a test.

Confirmed in the same run: `new DatabaseSync(path, { allowExtension: true })` and
`db.loadExtension()` exist on Node 22.23.4. No real extension was loaded.

## Options

### A. Plain SQLite table, exact search in JavaScript

An `embeddings` table next to the existing ones (`model_id`, source reference, `Float32` BLOB).

| Criterion | Assessment |
|---|---|
| New dependency | None. Nothing added to the installer or the licence register |
| Search | Exact, so no recall lost to an index. Fine at the scale above; slows in step with the row count |
| Forget | Best of the options. An ordinary row in the same file and transaction, covered by `secure_delete`. An in-memory copy must drop the row too |
| Scope filter | Simple: scan only the rows in scope |
| Windows | Nothing native to ship |
| Main cost | Roughly 2 MB per 1,000 vectors, plus RAM for the cached copy. Above about 50,000 scanned rows it needs a worker thread or a real index |

### B. sqlite-vec (`vec0` virtual table) loaded into `node:sqlite`

| Criterion | Assessment |
|---|---|
| New dependency | One native extension, `sqlite-vec` 0.1.9 (31 March 2026) with a `sqlite-vec-windows-x64` package. MIT or Apache-2.0 |
| Search | Stable releases are exact search in native code, likely faster than option A per row (not measured). Approximate indexes (DiskANN, rescore) exist only in 0.1.10 alphas (latest alpha.4, May 2026), IVF is marked experimental, docs "coming soon" |
| Forget | Same file and can be in the same transaction. Must be proven: alpha notes say DiskANN deletes are expensive because compressed neighbour vectors are left behind, which matters for forget. Do not use DiskANN without a test that shows erased vectors are gone from the file |
| Scope filter | `vec0` supports metadata columns; the exact behaviour with our scopes is untested |
| Windows | Prebuilt binary exists. Loading it into the bundled `node.exe`, and whether it is compatible with the bridge's SQLite settings, is untested |
| Main cost | `allowExtension: true` turns on extension loading for the memory database. The docs provide `enableLoadExtension(false)` to turn it off after loading, which we must do. Project was revived after a long hiatus, pre-1.0, 155 open issues as of the check |

The fork `@photostructure/sqlite-vec` (1.1.1) describes itself as production-ready, with added
testing and hardening, Windows x64 and ARM64 prebuilds and no post-install scripts. If option B is
ever taken, compare it with upstream first. It has a single company maintainer.

### C. LanceDB (embedded)

| Criterion | Assessment |
|---|---|
| New dependency | `@lancedb/lancedb` 0.19.0, Apache-2.0, with Windows x64 and arm64 native packages (native size not confirmed) |
| Search | Built for much larger data than this, with approximate indexes and its own hybrid search |
| Forget | A second store on disk, outside the SQLite transaction. `secure_delete` does not apply. Deletion in a versioned columnar format has to be compacted and proven; a crash between stores can leave a vector behind |
| Scope filter | Metadata filters exist; would duplicate scope data from SQLite |
| Windows | Supported on paper, not tested here |
| Main cost | Two stores to back up, export, restore and keep in step (plans 07 and 17). Far beyond what one household needs |

### D. Vector server (Qdrant, Chroma)

Both are Apache-2.0 and capable, but embedded use is described for Python or via a separate service,
and the JavaScript path was not confirmed. A background server to install, start, secure and update
on a non-technical user's Windows PC goes against the one-installer product. **Not recommended.**

### E. In-process ANN libraries (hnswlib, usearch)

Not studied in depth. They would add a native dependency *and* a second index file to keep in step
with SQLite, with the same forget problem as C, to solve a speed problem that does not exist yet.

## Comparison

| | A. Plain SQLite | B. sqlite-vec | C. LanceDB | D. Server |
|---|---|---|---|---|
| New native code | None | One extension | Large | Separate service |
| Same transaction as memories | Yes | Yes | No | No |
| Forget is provable today | Yes | Needs a test | Needs a test | Needs a test |
| Good at 100k vectors | Marginal (worker needed) | Likely | Yes | Yes |
| Installer risk | None | Low to medium | Medium | High |

## Recommendation

**Option A, behind a small interface, with sqlite-vec as the pre-agreed next step if a trigger is
hit.** The data set is small, exact search has perfect index recall, and it adds no native code to
a store whose first duty is forgetting properly.

Concretely, for Q38:

1. Add a `VectorIndex` interface in the bridge (`upsert`, `remove`, `search(vector, scope, k)`), so
   switching to option B later touches one file.
2. Add an `embeddings` table with `model_id`, `dim`, source type and id, and the vector as a BLOB.
   Write and delete it in the same transaction as the source row (triggers or a foreign key). As in
   ADR 006, never compare vectors with different `model_id`; a model change re-embeds everything.
3. Filter by scope first, then scan. Never embed vault items.
4. Add a test that forgets a memory, then shows the vector is gone from the table, the cache and
   the file's bytes.
5. Run search in a worker thread if p95 on the owner's PC exceeds 20 ms. Record search time in the
   turn trace (plan 16), and add a Settings toggle.

**Triggers for moving to sqlite-vec:** search p95 above 50 ms on the owner's PC with a worker in
place, or more than 100,000 vectors in one scope. Stay on exact search unless an erase test passes.

## The embedding model is a linked choice

The store does not depend on the model except for dimension, but Q38 cannot start without one.

- **Suggested first candidate:** `multilingual-e5-small`, 384 dimensions, MIT, with ONNX weights
  for Transformers.js (`Xenova/multilingual-e5-small`). `@huggingface/transformers` 3.8.1 is already
  in `package-lock.json` through `kokoro-js`.
- **Alternative:** `paraphrase-multilingual-MiniLM-L12-v2`, also 384 dimensions, but limited to 128 tokens.
- **Open risk:** Hindi and Gujarati quality is unproven. The only comparison found is a third-party
  document that rates both models low for these languages, with several scores estimated. Q38's
  test set must include paraphrases in Hindi and Gujarati, as well as Hindi-English mixing, before
  a model is accepted. `bge-m3` may do better but is much larger; it is the one to try if both fail.
- Licences above come from secondary pages. Confirm on the upstream card, bundle the file in the
  installer rather than downloading at run time, and add the licence-register row in Q38.

## Found while writing this: keyword search misses Hindi and Gujarati

This affects the "hybrid" half of Q38, whichever store is chosen. Tested on 2026-11-02:

- `ftsQuery()` in `bridge/memory.mjs` extracts words with `[\p{L}\p{N}]{3,}`. Vowel signs and the
  virama are marks, not letters, so words break apart. `'जन्मदिन'` yields no search term at all.
- FTS5's `unicode61` tokenizer does the same when storing: that sentence is indexed as fragments
  such as `जन`, `मद`, `न`. The `porter` stemmer is English only.

So keyword memory search currently finds little or nothing for Hindi and Gujarati prompts, which
matters given plan 28. Q38 should fix `ftsQuery()` to keep marks (`\p{M}`), and test `unicode61`
with `tokenchars`/category options or the `trigram` tokenizer, on a Hindi and Gujarati test set.

## Consequences and questions for the owner

- **Choosing A** means no new dependency or licence row for the store, at the cost of about 2 MB of
  disk per 1,000 vectors and a known limit that needs a later move if history grows very large.
- **Scope of embedding:** indexing only memories and journal events is smaller and more private.
  Indexing whole conversation history finds more, costs more disk, and makes a stronger forget
  promise necessary. Recommend starting with memories and events; Q38 can extend after measuring.
- **Please also confirm the embedding model** or leave it as Q38's first task, to be chosen by the
  test set. Filling `Decision:` with the store alone is enough to start Q38.

## Sources (checked 2026-11-02)

- [sqlite-vec releases](https://github.com/asg017/sqlite-vec/releases)
- [sqlite-vec npm metadata](https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/sqlite-vec) · [Windows x64 package](https://depscope.dev/pkg/npm/sqlite-vec-windows-x64)
- [@photostructure/sqlite-vec](https://www.pkgstats.com/pkg:@photostructure/sqlite-vec)
- [Node.js `node:sqlite` documentation](https://r2.nodejs.org/docs/latest/api/sqlite.html)
- [@lancedb/lancedb on npm](https://npmjs.com/package/@lancedb/lancedb)
- [Qdrant vs Chroma, October 2026](https://www.kunalganglani.com/blog/qdrant-vs-chroma.md) (third-party)
- [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) · [ONNX copy naming the MIT licence](https://huggingface.co/skillsafe-ai/multilingual-e5-small) (third-party)
- [Embedding language comparison](https://glama.ai/mcp/servers/@okets/folder-mcp/blob/d01bb52143b8721e59eae8d588a80c2dd8391cc9/docs/features/detailed-language-performance-research.md) (third-party, partly estimated)
- Local: `bridge/memory.mjs`, `scripts/package.mjs`, `shared/contracts.ts`, `package-lock.json`
