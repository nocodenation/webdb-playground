/**
 * Custom OpenCode tool — PDF ingester for the WebDB Playground RAG store.
 *
 * Reads a PDF (or a folder of PDFs), extracts text page-by-page, chunks at
 * ~400 tokens with 50-token overlap, embeds each chunk via the project's
 * self-hosted OpenAI-compatible endpoint ($OPENCODE_EMBEDDING_HOST), and
 * inserts rows into rag_documents / rag_chunks via PostgREST. The chunk
 * embedding column is `vector(4096)`; pgvector's binary-quantization HNSW
 * index handles the 2000-dim HNSW limit at index time, so we store the raw
 * float vector and let the index/queries do the quantization.
 *
 * Runs inside the opencode container. PostgREST is reached at the docker
 * service URL; auth comes from $POSTGREST_API_KEY. No .env file is read.
 *
 * Tool surface:
 *   input             string   PDF file or folder (non-recursive)
 *   title?            string   override (single-file only)
 *   dry_run?          bool     parse+chunk only, no API/DB
 *   estimate_only?    bool     report chunk + token totals, no API/DB
 *   skip_existing?    bool     dedup against rag_documents by filename
 *   collision_policy? enum     fingerprint | skip | ingest | fail
 */

import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import { getEncoding } from "js-tiktoken"
import { extractText, getDocumentProxy } from "unpdf"

// === Config ===
/*
TODO:
 - add OpenAI embedding model support (with 4096-bit vectors as well) if user have provided OPENCODE_OPENAI_KEY.
 - Do not use self-hosted embedding if OPENCODE_EMBEDDING_HOST and OPENCODE_EMBEDDING_MODEL are not provided
 - If user defined both OPENCODE_EMBEDDING_HOST+OPENCODE_EMBEDDING_MODEL, and OPENCODE_OPENAI_KEY - should give user a choice which embedding to use
 - If neither OPENCODE_EMBEDDING_HOST+OPENCODE_EMBEDDING_MODEL, nor OPENCODE_OPENAI_KEY provided - the tool should not try to do anything and report LLM why it can not ingest pdfs
 */
const DEFAULT_POSTGREST = "http://postgrest_app:3000"
const EMBED_DIMS = 4096 // llama-embed-nemotron-8b output; matches bit(4096) column
const CHUNK_TOKENS = 400
const CHUNK_OVERLAP = 50
const MAX_RETRIES = 6
const INITIAL_BACKOFF_S = 2.0
const MAX_BACKOFF_S = 60.0

const enc = getEncoding("cl100k_base")

type Chunk = {
    chunk_index: number
    content: string
    token_count: number | null
    metadata: Record<string, unknown>
}

type Fingerprint = { file_size: number; mtime: number; sha256: string }

type Logger = (line: string) => void

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// === PDF -> per-page text ===
async function extractPages(pdfPath: string, log: Logger): Promise<string[]> {
    const buf = await fs.readFile(pdfPath)
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const result = await extractText(pdf, { mergePages: false })
    const pages: string[] = Array.isArray(result.text) ? result.text : [String(result.text ?? "")]
    for (let i = 0; i < pages.length; i++) {
        if (typeof pages[i] !== "string") {
            log(`  warning: page ${i + 1} extract returned non-string`)
            pages[i] = ""
        }
    }
    return pages
}

// === Chunking ===
function chunkText(text: string, chunkSize = CHUNK_TOKENS, overlap = CHUNK_OVERLAP): string[] {
    const trimmed = text.trim()
    if (!trimmed) return []
    const toks = enc.encode(trimmed)
    if (toks.length <= chunkSize) return [trimmed]
    const step = chunkSize - overlap
    const chunks: string[] = []
    for (let start = 0; start < toks.length; start += step) {
        const window = toks.slice(start, start + chunkSize)
        if (!window.length) break
        chunks.push(enc.decode(window))
        if (start + chunkSize >= toks.length) break
    }
    return chunks
}

function buildChunks(pages: string[]): Chunk[] {
    const out: Chunk[] = []
    let chunkIdx = 0
    pages.forEach((pageText, i) => {
        const pageNo = i + 1
        for (const piece of chunkText(pageText)) {
            const pieceClean = piece.trim()
            if (!pieceClean) continue
            out.push({
                chunk_index: chunkIdx,
                content: pieceClean,
                token_count: enc.encode(pieceClean).length,
                metadata: { page: pageNo },
            })
            chunkIdx++
        }
    })
    return out
}

function estimateTokens(texts: string[]): number {
    return texts.reduce((acc, t) => acc + enc.encode(t).length, 0)
}

// === Embedding via self-hosted OpenAI-compatible endpoint ===
type EmbeddingResponse = {
    data?: Array<{ embedding: number[] }>
    embedding?: number[]
}

function vectorLiteral(vec: number[]): string {
    // pgvector accepts "[v1,v2,...]" as a string literal; PostgREST casts on insert.
    return "[" + vec.map((x) => x.toFixed(7)).join(",") + "]"
}

async function embedText(host: string, model: string, text: string, log: Logger): Promise<number[]> {
    const url = `${host.replace(/\/$/, "")}/v1/embeddings`
    let attempt = 0
    let backoff = INITIAL_BACKOFF_S
    while (true) {
        let r: Response
        try {
            r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model, input: text }),
            })
        } catch (e) {
            // Network-level error (DNS, refused, reset). Treat as transient.
            attempt++
            if (attempt > MAX_RETRIES) throw e
            const msg = (e as { message?: string })?.message ?? String(e)
            log(`  transient network error contacting ${url}: ${msg}, retry ${attempt}/${MAX_RETRIES} in ${backoff.toFixed(1)}s`)
            await sleep(backoff * 1000)
            backoff = Math.min(backoff * 2, MAX_BACKOFF_S)
            continue
        }
        if (r.ok) {
            const body = (await r.json()) as EmbeddingResponse
            // Accept both OpenAI-style (data[0].embedding) and llama.cpp-native (embedding).
            const vec = body.data?.[0]?.embedding ?? body.embedding
            if (!Array.isArray(vec)) {
                throw new Error("embedding response missing 'data[0].embedding' or 'embedding'")
            }
            if (vec.length !== EMBED_DIMS) {
                throw new Error(`expected ${EMBED_DIMS} dims, got ${vec.length}`)
            }
            return vec
        }
        // HTTP error — retry only on rate-limit / transient server / timeout codes.
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(r.status)
        if (!retryable) {
            const txt = await r.text().catch(() => "")
            throw new Error(`embedding HTTP ${r.status}: ${txt}`)
        }
        attempt++
        if (attempt > MAX_RETRIES) {
            const txt = await r.text().catch(() => "")
            throw new Error(`embedding HTTP ${r.status} after ${MAX_RETRIES} retries: ${txt}`)
        }
        let wait = backoff
        const ra = r.headers.get("retry-after")
        if (ra) {
            const n = parseFloat(ra)
            if (Number.isFinite(n)) wait = Math.max(wait, n)
        }
        log(`  transient HTTP ${r.status} from embedding endpoint, retry ${attempt}/${MAX_RETRIES} in ${wait.toFixed(1)}s`)
        await sleep(wait * 1000)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_S)
    }
}

async function embedAll(
    host: string,
    model: string,
    texts: string[],
    log: Logger,
): Promise<number[][]> {
    // The instructions.md example posts a single string per request. Some
    // OpenAI-compatible servers accept an array, but to match the documented
    // usage exactly, embed sequentially.
    const out: number[][] = []
    const total = texts.length
    for (let i = 0; i < total; i++) {
        out.push(await embedText(host, model, texts[i], log))
        if ((i + 1) % 10 === 0 || i + 1 === total) {
            log(`  embedded ${i + 1}/${total}`)
        }
    }
    return out
}

// === File fingerprint ===
async function fileFingerprint(filePath: string): Promise<Fingerprint> {
    const st = await fs.stat(filePath)
    const h = crypto.createHash("sha256")
    const buf = await fs.readFile(filePath)
    h.update(buf)
    return {
        file_size: st.size,
        mtime: st.mtimeMs / 1000, // seconds, to align with anything written from python-side scripts
        sha256: h.digest("hex"),
    }
}

function fingerprintMatches(
    fpNew: Fingerprint,
    metaExisting: Record<string, unknown>,
): [boolean, string] {
    const sha = metaExisting?.sha256 as string | undefined
    if (sha) {
        if (sha === fpNew.sha256) return [true, "sha256 match"]
        return [false, `sha256 differs (db=${sha.slice(0, 12)}..., new=${fpNew.sha256.slice(0, 12)}...)`]
    }
    const sizeDb = metaExisting?.file_size as number | undefined
    const mtimeDb = metaExisting?.mtime as number | undefined
    if (sizeDb != null && mtimeDb != null) {
        if (sizeDb === fpNew.file_size && Math.abs(mtimeDb - fpNew.mtime) < 1e-3) {
            return [true, "size+mtime match"]
        }
        return [false, `size/mtime differ (db=${sizeDb}/${mtimeDb}, new=${fpNew.file_size}/${fpNew.mtime})`]
    }
    return [false, "no fingerprint in existing row"]
}

// === PostgREST writers ===
type PgrestDocRow = { id: number; filename: string; source_path: string; metadata: Record<string, unknown> }

async function pgrestGetExistingByFilename(
    base: string,
    apiKey: string,
    filename: string,
    log: Logger,
): Promise<PgrestDocRow[]> {
    const url = `${base}/rag_documents?select=id,filename,source_path,metadata&filename=eq.${encodeURIComponent(filename)}`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!r.ok) {
        log(`warning: filename lookup failed: ${r.status} ${await r.text()}`)
        return []
    }
    return (await r.json()) as PgrestDocRow[]
}

async function pgrestInsert(
    base: string,
    apiKey: string,
    table: string,
    rows: unknown[],
    log: Logger,
): Promise<unknown[]> {
    const url = `${base}/${table}`
    const r = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Prefer: "return=representation",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(rows),
    })
    if (!r.ok) {
        const txt = await r.text()
        log(`error inserting into ${table}: ${r.status} ${txt}`)
        throw new Error(`PostgREST insert failed (${table}): ${r.status} ${txt}`)
    }
    return (await r.json()) as unknown[]
}

// === Per-file orchestration ===
async function preparePdf(pdfPath: string, log: Logger): Promise<{ pages: string[]; chunks: Chunk[] }> {
    log(`[1/5] reading PDF: ${pdfPath}`)
    const pages = await extractPages(pdfPath, log)
    const totalChars = pages.reduce((a, p) => a + p.length, 0)
    log(`      pages=${pages.length} chars=${totalChars}`)
    if (totalChars === 0) throw new Error("no extractable text (scanned PDF? OCR not supported)")
    log(`[2/5] chunking (~${CHUNK_TOKENS} tokens, ${CHUNK_OVERLAP} overlap)`)
    const chunks = buildChunks(pages)
    log(`      chunks=${chunks.length}`)
    if (!chunks.length) throw new Error("no chunks produced")
    return { pages, chunks }
}

async function ingestOne(
    args: {
        pdfPath: string
        pages: string[]
        chunks: Chunk[]
        embedHost: string
        embedModel: string
        apiKey: string
        postgrestUrl: string
        titleOverride: string | null
        fingerprint: Fingerprint | null
    },
    log: Logger,
): Promise<{ documentId: number; chunkCount: number }> {
    const { pdfPath, pages, chunks, embedHost, embedModel, apiKey, postgrestUrl, titleOverride, fingerprint } = args
    log(`[3/5] embedding via ${embedHost} model=${embedModel} (dims=${EMBED_DIMS})`)
    const chunkTexts = chunks.map((c) => c.content)
    const vecs = await embedAll(embedHost, embedModel, chunkTexts, log)
    if (vecs.length !== chunks.length) {
        throw new Error(`embedding count mismatch ${vecs.length} vs ${chunks.length}`)
    }

    log(`[4/5] inserting rag_documents row`)
    const docMeta: Record<string, unknown> = {
        title: titleOverride ?? path.basename(pdfPath, path.extname(pdfPath)),
        page_count: pages.length,
        chunk_count: chunks.length,
        embed_model: embedModel,
        embed_dims: EMBED_DIMS,
        chunk_tokens: CHUNK_TOKENS,
        chunk_overlap: CHUNK_OVERLAP,
    }
    if (fingerprint) Object.assign(docMeta, fingerprint)
    const docRows = (await pgrestInsert(
        postgrestUrl,
        apiKey,
        "rag_documents",
        [{ filename: path.basename(pdfPath), source_path: path.resolve(pdfPath), metadata: docMeta }],
        log,
    )) as Array<{ id: number }>
    const docId = docRows[0].id
    log(`      document_id=${docId}`)

    log(`[5/5] inserting rag_chunks (${chunks.length} rows)`)
    // Each row serializes ~4096 floats at 7-decimal precision (~37 KB) plus
    // content; 10 rows per request stays under the nginx proxy's default
    // 1 MB request limit.
    const BATCH = 10
    for (let i = 0; i < chunks.length; i += BATCH) {
        const batchChunks = chunks.slice(i, i + BATCH)
        const batchVecs = vecs.slice(i, i + BATCH)
        const rows = batchChunks.map((c, idx) => ({
            document_id: docId,
            chunk_index: c.chunk_index,
            content: c.content,
            token_count: c.token_count,
            metadata: c.metadata,
            embedding: vectorLiteral(batchVecs[idx]),
        }))
        await pgrestInsert(postgrestUrl, apiKey, "rag_chunks", rows, log)
        log(`      inserted ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`)
    }
    return { documentId: docId, chunkCount: chunks.length }
}

async function findPdfs(folder: string, log: Logger): Promise<string[]> {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    const pdfs: string[] = []
    let other = 0
    for (const e of entries) {
        if (e.isDirectory()) continue
        if (e.name.toLowerCase().endsWith(".pdf")) pdfs.push(path.join(folder, e.name))
        else other++
    }
    if (other) log(`note: ${other} non-PDF file(s) in folder skipped`)
    pdfs.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()))
    return pdfs
}

// === Tool definition ===
export default tool({
    description:
        "Ingest a PDF (or folder of PDFs) into the WebDB Playground RAG store (rag_documents, rag_chunks) via PostgREST. Extracts text, chunks ~400 tokens with 50-token overlap, embeds via the self-hosted OPENCODE_EMBEDDING_HOST endpoint, and inserts rows with the raw 4096-dim float vector (binary quantization is applied at index time by pgvector).",
    args: {
        input: tool.schema
            .string()
            .describe("Absolute or worktree-relative path to a PDF file OR a folder of PDFs (non-recursive). Files uploaded by the user typically live under /data."),
        title: tool.schema
            .string()
            .optional()
            .describe("Override document title (single-file mode only; ignored for folders). Defaults to filename stem."),
        dry_run: tool.schema
            .boolean()
            .optional()
            .describe("Parse and chunk but do not call the embedding endpoint or write to DB."),
        estimate_only: tool.schema
            .boolean()
            .optional()
            .describe("Print chunk + token totals per file and the batch sum, then exit (no API calls)."),
        skip_existing: tool.schema
            .boolean()
            .optional()
            .describe("Look up filename in rag_documents and skip if already ingested (see collision_policy)."),
        collision_policy: tool.schema
            .enum(["fingerprint", "skip", "ingest", "fail"])
            .optional()
            .describe(
                "How to handle filename matches when skip_existing is set. fingerprint (default): compare size+mtime+sha256, skip if same. skip: always skip. ingest: always ingest a new row. fail: abort the batch.",
            ),
    },
    async execute(args, context) {
        const logBuf: string[] = []
        const log: Logger = (line) => logBuf.push(line)

        const collisionPolicy = (args.collision_policy ?? "fingerprint") as
            | "fingerprint"
            | "skip"
            | "ingest"
            | "fail"
        const dryRun = !!args.dry_run
        const estimateOnly = !!args.estimate_only
        const skipExisting = !!args.skip_existing

        // Resolve input against the session working directory / worktree
        const baseDir = context.directory ?? context.worktree ?? process.cwd()
        const inputPath = path.isAbsolute(args.input) ? args.input : path.resolve(baseDir, args.input)

        let pdfPaths: string[]
        let folderMode = false
        try {
            const st = await fs.stat(inputPath)
            if (st.isFile()) {
                pdfPaths = [inputPath]
            } else if (st.isDirectory()) {
                pdfPaths = await findPdfs(inputPath, log)
                folderMode = true
                if (!pdfPaths.length) return `error: no .pdf files found in ${inputPath}`
                log(`folder mode: ${pdfPaths.length} PDF(s) found in ${inputPath}`)
                for (const p of pdfPaths) log(`  - ${path.basename(p)}`)
                if (args.title) log(`note: title is ignored in folder mode`)
            } else {
                return `error: not a file or directory: ${inputPath}`
            }
        } catch (e) {
            const msg = (e as { message?: string })?.message ?? String(e)
            return `error: cannot stat ${inputPath}: ${msg}`
        }

        // Env / config — all from process.env (no .env file inside the container).
        const apiKey = process.env.POSTGREST_API_KEY ?? ""
        const embedHost = process.env.OPENCODE_EMBEDDING_HOST ?? ""
        const embedModel = process.env.OPENCODE_EMBEDDING_MODEL ?? ""
        const postgrestUrl = process.env.POSTGREST_URL ?? DEFAULT_POSTGREST

        const needsEmbed = !(dryRun || estimateOnly)
        const needsPgrest = !(dryRun || estimateOnly)
        if (needsEmbed && !embedHost) return "error: OPENCODE_EMBEDDING_HOST not set"
        if (needsEmbed && !embedModel) return "error: OPENCODE_EMBEDDING_MODEL not set"
        if (needsPgrest && !apiKey) return "error: POSTGREST_API_KEY not set"

        // Phase 1: parse + chunk + fingerprint each PDF
        type Prepared = {
            path: string
            pages: string[]
            chunks: Chunk[]
            tokens: number
            fingerprint: Fingerprint | null
        }
        const prepared: Prepared[] = []
        const parseFailures: [string, string][] = []
        for (let idx = 0; idx < pdfPaths.length; idx++) {
            const pdf = pdfPaths[idx]
            log(`\n=== [${idx + 1}/${pdfPaths.length}] ${path.basename(pdf)} ===`)
            let pages: string[]
            let chunks: Chunk[]
            try {
                ;({ pages, chunks } = await preparePdf(pdf, log))
            } catch (e) {
                const name = (e as { constructor?: { name?: string } })?.constructor?.name ?? "Error"
                const msg = (e as { message?: string })?.message ?? String(e)
                log(`  SKIP: parse failure: ${name}: ${msg}`)
                parseFailures.push([pdf, `${name}: ${msg}`])
                continue
            }
            let fp: Fingerprint | null = null
            try {
                fp = await fileFingerprint(pdf)
            } catch (e) {
                const msg = (e as { message?: string })?.message ?? String(e)
                log(`  warning: fingerprint failed for ${path.basename(pdf)}: ${msg}`)
            }
            const tokens = estimateTokens(chunks.map((c) => c.content))
            log(`      total_tokens~=${tokens}` + (fp ? `  sha256=${fp.sha256.slice(0, 12)}...` : ""))
            prepared.push({ path: pdf, pages, chunks, tokens, fingerprint: fp })
        }

        if (!prepared.length) {
            log("error: no PDFs successfully parsed; nothing to ingest")
            return logBuf.join("\n")
        }

        // Phase 1b: dedup against rag_documents
        const dedupSkips: [string, string][] = []
        let prep = prepared
        if (skipExisting && !apiKey) {
            log("warning: skip_existing requires POSTGREST_API_KEY; dedup check disabled")
        }
        if (skipExisting && apiKey) {
            const kept: Prepared[] = []
            for (const p of prep) {
                const existing = await pgrestGetExistingByFilename(
                    postgrestUrl,
                    apiKey,
                    path.basename(p.path),
                    log,
                )
                if (!existing.length) {
                    kept.push(p)
                    continue
                }
                const existingIds = existing.map((r) => String(r.id))
                if (collisionPolicy === "ingest") {
                    log(`  collision: ${path.basename(p.path)} matches doc_id(s) ${existingIds.join(",")} -- policy=ingest, will create new row`)
                    kept.push(p)
                    continue
                }
                if (collisionPolicy === "skip") {
                    const reason = `filename match (doc_id=${existingIds.join(",")}), policy=skip`
                    log(`  SKIP ${path.basename(p.path)}: ${reason}`)
                    dedupSkips.push([p.path, reason])
                    continue
                }
                if (collisionPolicy === "fail") {
                    log(`error: filename match for ${path.basename(p.path)} (doc_id=${existingIds.join(",")}); policy=fail`)
                    return logBuf.join("\n")
                }
                // fingerprint policy
                if (!p.fingerprint) {
                    const reason = `filename match (doc_id=${existingIds.join(",")}), local fingerprint unavailable`
                    log(`  SKIP ${path.basename(p.path)}: ${reason}`)
                    dedupSkips.push([p.path, reason])
                    continue
                }
                let anyMatch = false
                let matchedId: number | null = null
                let matchedWhy = ""
                const noFpRows: number[] = []
                const mismatchDetails: string[] = []
                for (const row of existing) {
                    const meta = (row.metadata ?? {}) as Record<string, unknown>
                    const [matched, why] = fingerprintMatches(p.fingerprint, meta)
                    if (matched) {
                        anyMatch = true
                        matchedId = row.id
                        matchedWhy = why
                        break
                    }
                    if (why.includes("no fingerprint")) noFpRows.push(row.id)
                    else mismatchDetails.push(`id=${row.id} ${why}`)
                }
                if (anyMatch) {
                    const reason = `fingerprint duplicate of doc_id=${matchedId} (${matchedWhy})`
                    log(`  SKIP ${path.basename(p.path)}: ${reason}`)
                    dedupSkips.push([p.path, reason])
                    continue
                }
                if (noFpRows.length && !mismatchDetails.length) {
                    const reason = `filename match (doc_id=${noFpRows.join(",")}) has no fingerprint in DB; assuming duplicate`
                    log(`  SKIP ${path.basename(p.path)}: ${reason}`)
                    dedupSkips.push([p.path, reason])
                    continue
                }
                log(`  collision: ${path.basename(p.path)} filename matches doc_id(s) ${existingIds.join(",")} but fingerprint differs -- ingesting as new row`)
                for (const d of mismatchDetails) log(`    ${d}`)
                kept.push(p)
            }
            prep = kept
            if (dedupSkips.length) log(`\nskipped ${dedupSkips.length} file(s) due to skip_existing`)
            if (!prep.length) {
                log("nothing to ingest after dedup; all files already present.")
                log("\n=== SUMMARY ===")
                log(`  succeeded: 0/${pdfPaths.length}`)
                log(`  skipped (dedup): ${dedupSkips.length}`)
                for (const [pth, reason] of dedupSkips) log(`    SKIP ${path.basename(pth)}: ${reason}`)
                if (parseFailures.length) {
                    log(`  parse failures: ${parseFailures.length}`)
                    for (const [pth, msg] of parseFailures) log(`    FAIL ${path.basename(pth)}: ${msg}`)
                }
                return logBuf.join("\n")
            }
        }

        // Batch totals (informational only — no cost estimate for self-hosted)
        const totalTokens = prep.reduce((a, p) => a + p.tokens, 0)
        const totalChunks = prep.reduce((a, p) => a + p.chunks.length, 0)
        log(`\nbatch total: ${prep.length} doc(s), ${totalChunks} chunk(s), ~${totalTokens} tokens (model=${embedModel || "<unset>"}, dims=${EMBED_DIMS})`)

        if (dryRun) {
            const sample = prep[0].chunks[0]
            log("[dry-run] sample chunk[0] of first PDF:")
            log(JSON.stringify({ ...sample, content: sample.content.slice(0, 300) + "..." }, null, 2))
            return logBuf.join("\n")
        }
        if (estimateOnly) {
            log("[estimate-only] done; no API calls made.")
            return logBuf.join("\n")
        }

        // Phase 2: embed + insert
        const successes: [string, number, number][] = []
        const ingestFailures: [string, string][] = []
        const titleOverride = folderMode ? null : (args.title ?? null)
        for (let idx = 0; idx < prep.length; idx++) {
            const p = prep[idx]
            log(`\n=== INGEST [${idx + 1}/${prep.length}] ${path.basename(p.path)} ===`)
            try {
                const { documentId, chunkCount } = await ingestOne(
                    {
                        pdfPath: p.path,
                        pages: p.pages,
                        chunks: p.chunks,
                        embedHost,
                        embedModel,
                        apiKey,
                        postgrestUrl,
                        titleOverride,
                        fingerprint: p.fingerprint,
                    },
                    log,
                )
                successes.push([p.path, documentId, chunkCount])
            } catch (e) {
                const name = (e as { constructor?: { name?: string } })?.constructor?.name ?? "Error"
                const msg = (e as { message?: string })?.message ?? String(e)
                log(`  SKIP: ingest failure: ${name}: ${msg}`)
                ingestFailures.push([p.path, `${name}: ${msg}`])
            }
        }

        // Final summary
        log("\n=== SUMMARY ===")
        log(`  succeeded: ${successes.length}/${pdfPaths.length}`)
        for (const [pth, docId, n] of successes) log(`    OK   ${path.basename(pth)}  document_id=${docId}  chunks=${n}`)
        if (dedupSkips.length) {
            log(`  skipped (dedup): ${dedupSkips.length}`)
            for (const [pth, reason] of dedupSkips) log(`    SKIP ${path.basename(pth)}: ${reason}`)
        }
        if (parseFailures.length) {
            log(`  parse failures: ${parseFailures.length}`)
            for (const [pth, msg] of parseFailures) log(`    FAIL ${path.basename(pth)}: ${msg}`)
        }
        if (ingestFailures.length) {
            log(`  ingest failures: ${ingestFailures.length}`)
            for (const [pth, msg] of ingestFailures) log(`    FAIL ${path.basename(pth)}: ${msg}`)
        }

        return logBuf.join("\n")
    },
})
