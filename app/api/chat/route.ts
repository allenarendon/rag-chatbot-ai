/**
 * Final Route Handler — Step 4 of Section 4 (RAG-as-tool-call) +
 * the source metadata used by Step 5's UI.
 *
 * The model decides whether to call the getInformation tool. When it does,
 * the tool runs vector search and returns chunk text + page + score. The
 * client renders those as collapsible sources under the assistant message.
 */
import { openai } from '@ai-sdk/openai';
import { streamText, tool, embed } from 'ai';
import { Index } from '@upstash/vector';
import { z } from 'zod';
import { catalogPrompt, sourceEntry } from '@/lib/sources';

const index = new Index();

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system:
      'You are AI-Tee, a helpful, friendly, and witty IT helpdesk assistant. ' +
      'Help with everyday IT concerns: accounts and passwords, email, Wi-Fi, VPN, printers, software, hardware, error messages, and what to try before opening a ticket. ' +
      'Sound like a sharp colleague: warm, clear, and lightly funny. Never mock the person. Explain jargon in plain language. ' +
      'Lead with the most useful next step, then the short why. ' +
      'The indexed documents are IT helpdesk work instructions. ' +
      'Call getInformation before you answer, so the user can open Sources and see the top matching passages. ' +
      'Follow the steps, identity checks, and escalation rules in what the tool returns. ' +
      'If those documents do not cover the question, say so and give general IT helpdesk guidance rather than guessing. ' +
      'Do not cite a document that does not actually answer the question. ' +
      'If the question is outside IT helpdesk work, reply in one friendly line and invite an IT question. ' +
      'Write answers in Markdown that is easy to scan: short paragraphs, ' +
      'and a bullet or numbered list when you list steps, checks, or options. ' +
      'Put each list item on its own line. ' +
      'These are the indexed documents. Use them to choose the instruction that fits:\n' +
      catalogPrompt() +
      '\nWhen you answer, name the document title returned by the tool.',
    messages,
    tools: {
      getInformation: tool({
        description:
          'Search the indexed IT helpdesk work instructions and return the top matching passages. Call this before answering so those passages can be shown as Sources.',
        parameters: z.object({
          query: z
            .string()
            .describe('the topic, term, or sub-question to search for'),
        }),
        execute: async ({ query }) => {
          const { embedding } = await embed({
            model: openai.embedding('text-embedding-3-small'),
            value: query,
          });
          const hits = await index.query({
            vector: embedding,
            topK: 4,
            includeMetadata: true,
          });
          return hits.map((h) => {
            const filename = (h.metadata?.source as string) ?? '';
            const entry = filename ? sourceEntry(filename) : undefined;
            return {
              text: (h.metadata?.text as string) ?? '',
              page: (h.metadata?.page as number) ?? null,
              source: filename || null,
              title: entry?.title ?? ((h.metadata?.title as string) ?? null),
              topics: entry?.topics.join(', ') ?? ((h.metadata?.topics as string) ?? null),
              score: h.score,
            };
          });
        },
      }),
    },
    maxSteps: 3,
    prepareStep: async ({ stepNumber }) => {
      if (stepNumber === 0) {
        return { toolChoice: { type: 'tool', toolName: 'getInformation' } };
      }
      return { toolChoice: 'none' };
    },
  });

  return result.toDataStreamResponse();
}
