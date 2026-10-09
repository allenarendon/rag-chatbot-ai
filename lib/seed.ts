/**
 * Seed Upstash Vector with chunks from every PDF in data/.
 *
 * Run once before starting the chat:
 *   npm run seed
 *
 * Re-run any time you add, replace, or remove a PDF in data/.
 * Existing chunks are overwritten by id (filename + chunk index).
 */
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// Next.js reads .env.local automatically; this script does not.
loadEnv({ path: path.join(process.cwd(), '.env.local') });
import { Index } from '@upstash/vector';
import * as ai from 'ai';
import { openai } from '@ai-sdk/openai';
import { traceable } from 'langsmith/traceable';
import { wrapAISDK } from 'langsmith/experimental/vercel';

const { embedMany: sdkEmbedMany } = wrapAISDK(ai);
const embedMany = traceable(sdkEmbedMany, {
  name: 'embedMany',
  run_type: 'embedding',
});
// pdf-parse uses CommonJS; default-import the parser fn
import pdfParse from 'pdf-parse';
import { embeddingPrefix, sourceEntry } from './sources';

// pdf-parse rejects in the background on PDFs with a broken xref table.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/xref|format|illegal character/i.test(message)) return;
  console.error(reason);
  process.exit(1);
});

const DATA_DIR = path.join(process.cwd(), 'data');
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 400;
// Stay under OpenAI's 300k-token cap per embeddings request.
const EMBED_TOKEN_BUDGET = 200_000;
const UPSERT_BATCH = 100;

type Chunk = { text: string; page: number; source: string; index: number };

/**
 * Naive but adequate chunker: split text into ~800-char windows with 100-char
 * overlap, attempting to break on sentence boundaries when possible.
 */
function chunkText(text: string, page: number): Array<Pick<Chunk, 'text' | 'page'>> {
  const out: Array<Pick<Chunk, 'text' | 'page'>> = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + CHUNK_SIZE);
    // Try to extend to the next sentence boundary if we're not at the end.
    if (end < text.length) {
      const lookahead = text.slice(end, end + 200);
      const m = lookahead.match(/[.!?]\s/);
      if (m && m.index !== undefined) end += m.index + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece.length > 0) out.push({ text: piece, page });
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function batchChunks(chunks: Chunk[]): Chunk[][] {
  const batches: Chunk[][] = [];
  let current: Chunk[] = [];
  let tokens = 0;
  for (const chunk of chunks) {
    const chunkTokens = estimateTokens(embeddingPrefix(chunk.source) + chunk.text);
    if (current.length > 0 && tokens + chunkTokens > EMBED_TOKEN_BUDGET) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(chunk);
    tokens += chunkTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function listPdfFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function ascii85Decode(input: string): Buffer {
  let str = input.replace(/\s+/g, '');
  if (str.endsWith('~>')) str = str.slice(0, -2);
  const out: number[] = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === 'z') {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const chunk = str.slice(i, i + 5);
    i += chunk.length;
    let value = 0;
    for (let j = 0; j < 5; j++) {
      const code = j < chunk.length ? chunk.charCodeAt(j) : 117;
      value = value * 85 + (code - 33);
    }
    const bytes = chunk.length < 5 ? chunk.length - 1 : 4;
    const decoded = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    for (let j = 0; j < bytes; j++) out.push(decoded[j]);
  }
  return Buffer.from(out);
}

function unescapePdfString(raw: string): string {
  return raw
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\([()\\])/g, '$1');
}

/**
 * Some of these work-instruction PDFs have a broken xref table, so pdf-parse
 * cannot read them. The page text is still in ASCII85 + Flate streams.
 */
function pagesFromContentStreams(buf: Buffer): string[] {
  const source = buf.toString('latin1');
  const streams = /stream\r?\n([\s\S]*?)endstream/g;
  const pages: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = streams.exec(source))) {
    try {
      const content = zlib.inflateSync(ascii85Decode(match[1])).toString('latin1');
      const texts: string[] = [];
      const strings = /\((?:\\.|[^\\)])*\)/g;
      let text: RegExpExecArray | null;
      while ((text = strings.exec(content))) {
        const value = unescapePdfString(text[0].slice(1, -1)).trim();
        if (value) texts.push(value);
      }
      const page = texts.join(' ').replace(/\u007f/g, '\n').replace(/[ \t]+/g, ' ').trim();
      if (page) pages.push(page);
    } catch {
      // Font or metadata streams are not page text.
    }
  }
  return pages;
}

async function loadAndChunkPdf(filePath: string): Promise<Chunk[]> {
  const source = path.basename(filePath);
  const buf = await fs.readFile(filePath);
  let pages: string[] = [];
  try {
    const parsed = await pdfParse(buf);
    pages = parsed.text
      .split('\f')
      .map((page) => page.trim())
      .filter((page) => page.length > 0);
  } catch {
    pages = [];
  }
  if (pages.join('').trim().length < 200) {
    pages = pagesFromContentStreams(buf);
  }
  const chunks: Array<Pick<Chunk, 'text' | 'page'>> = [];
  pages.forEach((pageText, pageIdx) => {
    chunks.push(...chunkText(pageText.trim(), pageIdx + 1));
  });
  return chunks.map((chunk, index) => ({ ...chunk, source, index }));
}

async function main() {
  if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
    console.error('Missing UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN. Set them in .env.local.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local.');
    process.exit(1);
  }

  const pdfPaths = await listPdfFiles(DATA_DIR);
  if (pdfPaths.length === 0) {
    console.error(`No PDF files found in ${DATA_DIR}`);
    process.exit(1);
  }

  const chunks: Chunk[] = [];
  for (const pdfPath of pdfPaths) {
    console.log(`Loading and chunking ${pdfPath}…`);
    const fileChunks = await loadAndChunkPdf(pdfPath);
    const filename = path.basename(pdfPath);
    if (!sourceEntry(filename)) {
      console.warn(`  No catalog entry for ${filename}. Add it to data/sources.json.`);
    }
    console.log(`  ${filename}: ${fileChunks.length} chunks`);
    chunks.push(...fileChunks);
  }
  if (chunks.length === 0) {
    console.error('PDFs were found, but none produced text chunks.');
    process.exit(1);
  }
  console.log(`  produced ${chunks.length} chunks from ${pdfPaths.length} PDF(s)`);

  const index = new Index();
  console.log('Clearing the vector index so sources match the current documents…');
  await index.reset();
  await seedWorkInstructions(chunks, index);
  console.log('✅ Done. Run `npm run dev` and chat at http://localhost:3000');
}

const seedWorkInstructions = traceable(
  async (chunks: Chunk[], index: Index) => {
    const batches = batchChunks(chunks);
    console.log(`Embedding ${chunks.length} chunks in ${batches.length} batch(es)…`);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      console.log(`Embedding batch ${b + 1}/${batches.length} (${batch.length} chunks)…`);
      const { embeddings } = await embedMany({
        model: openai.embedding('text-embedding-3-small'),
        values: batch.map((c) => `${embeddingPrefix(c.source)}${c.text}`),
      });
      const records = batch.map((c, i) => {
        const entry = sourceEntry(c.source);
        return {
          id: `${c.source}#${c.index}`,
          vector: embeddings[i],
          metadata: {
            text: c.text,
            page: c.page,
            source: c.source,
            title: entry?.title ?? c.source,
            topics: entry?.topics.join(', ') ?? '',
          },
        };
      });
      console.log(`Upserting batch ${b + 1}/${batches.length}…`);
      for (let i = 0; i < records.length; i += UPSERT_BATCH) {
        await index.upsert(records.slice(i, i + UPSERT_BATCH));
      }
    }
  },
  { name: 'seed-work-instructions', run_type: 'chain' },
);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
