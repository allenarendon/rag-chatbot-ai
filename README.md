# AI-Tee

Your AI buddy for IT helpdesk concerns. A helpful, friendly, and witty assistant. A streaming chat app built with [Next.js 15](https://nextjs.org/), the [Vercel AI SDK](https://sdk.vercel.ai/), and [Upstash Vector](https://upstash.com/docs/vector).

AI-Tee greets the user, answers everyday IT problems in Markdown, and keeps retrieved passages under a collapsed **Sources** control. A disclaimer under the message box asks the user to confirm anything that changes access, data, or company policy. Answers follow the IT helpdesk work instructions in `data/`.

## What's here

```
rag-chatbot/
├── app/
│   ├── globals.css
│   ├── layout.tsx                        # Geist, page title
│   ├── page.tsx                          # AI-Tee UI — useChat, Markdown, sources
│   └── api/chat/route.ts                 # RAG-as-tool-call handler
├── lib/
│   └── seed.ts                           # Embeds every PDF in data/
├── data/                                 # IT helpdesk work instructions (PDFs only are seeded)
├── steps/                                # Workshop snapshots (not the live UI)
├── package.json
├── .env.example
└── README.md
```

`data/` currently holds IT helpdesk work instructions WI-01 through WI-20, from password reset and onboarding through printers, VPN, security incidents, and web apps. `sources.json` is the catalog AI-Tee uses to choose an instruction.

## Setup

```bash
npm install

# macOS / Linux
cp .env.example .env.local
# Windows
copy .env.example .env.local
```

Edit `.env.local` and set `OPENAI_API_KEY`, `UPSTASH_VECTOR_REST_URL`, and `UPSTASH_VECTOR_REST_TOKEN`.

Seed the index once, and again whenever a PDF in `data/` is added, replaced, or removed:

```bash
npm run seed
```

The seed script reads every `.pdf` file directly in `data/`. It chunks each file, embeds the chunks with `text-embedding-3-small` in batches under OpenAI's per-request token limit, and upserts them to Upstash Vector. Chunk ids are `filename#index`, so re-running the seed overwrites chunks for the same file. Vectors for a PDF you delete from `data/` stay in the index until you remove them in Upstash.

## Run

```bash
npm run dev
# open http://localhost:3000
```

The first message is AI-Tee's greeting. Try asking:

- *"I got locked out of my email. What should I try first?"*
- *"The office printer says offline. Where do I start?"*
- *"How do I tell a VPN problem from a Wi-Fi problem?"*

Tokens stream into the assistant bubble as Markdown. The list follows the newest reply. **Sources** stays collapsed until you open it; each hit shows the PDF name, page, similarity score, and chunk text.

## Workshop snapshots

The `/steps` folder is the original Week 14A walkthrough. Copying those files over `app/page.tsx` or `app/api/chat/route.ts` replaces the AI-Tee UI and handler.

| Step | Files to copy | What it shows |
| ---- | ------------- | ------------- |
| 2 | `steps/step2-plain-chat/page.tsx` → `app/page.tsx` | useChat against plain streamText |
|   | `steps/step2-plain-chat/route.ts` → `app/api/chat/route.ts` | Streaming before retrieval |
| 4 | `steps/step4-rag-as-tool/route.ts` → `app/api/chat/route.ts` | The model decides when to retrieve |
| 5 | `steps/step5-sources/page.tsx` → `app/page.tsx` | Sources under each answer |

## Add or replace documents

1. Put `.pdf` files in `data/`. Other files in that folder are ignored.
2. Run `npm run seed`.
3. Restart `npm run dev` if it is already running.

## Deploy to Vercel

```bash
npm i -g vercel
vercel
vercel env add OPENAI_API_KEY
vercel env add UPSTASH_VECTOR_REST_URL
vercel env add UPSTASH_VECTOR_REST_TOKEN
vercel --prod
```

Seed locally once per index. The hosted app only needs the environment variables.

## Common errors

| Symptom | Fix |
| ------- | --- |
| `Missing UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN` | Set them in `.env.local`, then run `npm run seed`. |
| `No PDF files found in .../data` | Add at least one `.pdf` directly under `data/`. |
| `Requested … tokens, max 300000 tokens per request` | The seed batches embeddings. Pull the latest `lib/seed.ts` if you still see this. |
| Page renders but submitting hangs | The route must return `toDataStreamResponse()`. |
| Empty or very short answer after a tool call | Set `maxSteps: 3` on `streamText`. |
| `Cannot use useChat in a Server Component` | Keep `'use client'` at the top of `page.tsx`. |
| `vercel --prod` fails on missing env vars | Run `vercel env add` and choose **Production**. |
