/**
 * Final Route Handler — Step 4 of Section 4 (RAG-as-tool-call) +
 * the source metadata used by Step 5's UI.
 *
 * IT helpdesk questions search the work instructions first. Those hits are
 * written into the chat stream as Sources, then the answer is streamed.
 * Questions outside that work are answered directly, with no Sources.
 */
import { openai } from '@ai-sdk/openai';
import {
  appendResponseMessages,
  createDataStreamResponse,
  embed,
  formatDataStreamPart,
  generateText,
  streamText,
  tool,
  type Message,
} from 'ai';
import { Index } from '@upstash/vector';
import { z } from 'zod';
import { catalogPrompt, sourceEntry } from '@/lib/sources';

const index = new Index();

const system =
  'You are AI-Tee, a helpful, friendly, and witty IT helpdesk assistant. ' +
  'Help with everyday IT concerns: accounts and passwords, email, Wi-Fi, VPN, printers, software, hardware, error messages, and what to try before opening a ticket. ' +
  'Sound like a sharp colleague: warm, clear, and lightly funny. Never mock the person. Explain jargon in plain language. ' +
  'Lead with the most useful next step, then the short why. ' +
  'The indexed documents are IT helpdesk work instructions. ' +
  'Call getInformation only for an IT helpdesk question, before you answer, so the user can open Sources and see the matching passages. ' +
  'Follow the steps, identity checks, and escalation rules in what the tool returns. ' +
  'If those documents do not cover the question, say so and give general IT helpdesk guidance rather than guessing. ' +
  'Do not cite a document that does not actually answer the question. ' +
  'If the question is outside IT helpdesk work, do not call getInformation. Reply in one friendly line and invite an IT question. ' +
  'Write answers in Markdown that is easy to scan: short paragraphs, ' +
  'and a bullet or numbered list when you list steps, checks, or options. ' +
  'Put each list item on its own line. ' +
  'These are the indexed documents. Use them to choose the instruction that fits:\n' +
  catalogPrompt() +
  '\nWhen you answer, name the document title returned by the tool.';

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: Message[] };

  const retrieval = await generateText({
    model: openai('gpt-4o-mini'),
    system,
    messages,
    tools: {
      getInformation: tool({
        description:
          'Search the indexed IT helpdesk work instructions and return the top matching passages. Call this only for an IT helpdesk question, before answering, so those passages can be shown as Sources. Do not call it for anything else.',
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
    maxSteps: 1,
  });

  if (retrieval.toolCalls.length === 0) {
    return createDataStreamResponse({
      execute(dataStream) {
        dataStream.write(formatDataStreamPart('text', retrieval.text));
        dataStream.write(
          formatDataStreamPart('finish_step', {
            finishReason: 'stop',
            isContinued: false,
          }),
        );
        dataStream.write(
          formatDataStreamPart('finish_message', {
            finishReason: 'stop',
          }),
        );
      },
    });
  }

  return createDataStreamResponse({
    execute(dataStream) {
      for (const call of retrieval.toolCalls) {
        dataStream.write(
          formatDataStreamPart('tool_call', {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.args,
          }),
        );
      }
      for (const callResult of retrieval.toolResults) {
        dataStream.write(
          formatDataStreamPart('tool_result', {
            toolCallId: callResult.toolCallId,
            result: callResult.result,
          }),
        );
      }

      const answer = streamText({
        model: openai('gpt-4o-mini'),
        system,
        messages: appendResponseMessages({
          messages,
          responseMessages: retrieval.response.messages,
        }),
        toolChoice: 'none',
      });
      answer.mergeIntoDataStream(dataStream);
    },
  });
}
