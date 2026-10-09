/**
 * Final Route Handler — Step 4 of Section 4 (RAG-as-tool-call) +
 * the source metadata used by Step 5's UI.
 *
 * IT helpdesk questions search the work instructions first. Those hits are
 * written into the chat stream as Sources, then the answer is streamed.
 * Questions outside that work are answered directly, with no Sources.
 */
import { openai } from '@ai-sdk/openai';
import * as ai from 'ai';
import { Index } from '@upstash/vector';
import { RunTree } from 'langsmith';
import { traceable, withRunTree } from 'langsmith/traceable';
import { wrapAISDK } from 'langsmith/experimental/vercel';
import { after } from 'next/server';
import { z } from 'zod';
import { catalogPrompt, sourceEntry } from '@/lib/sources';

const { generateText, streamText, embed: sdkEmbed } = wrapAISDK(ai);
const embed = traceable(sdkEmbed, { name: 'embed', run_type: 'embedding' });

const { appendResponseMessages, createDataStreamResponse, formatDataStreamPart, tool } = ai;
type Message = ai.Message;

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
  const trace = new RunTree({
    name: 'ai-tee',
    run_type: 'chain',
    inputs: { messages },
  });
  let tracing = true;
  try {
    await trace.postRun();
  } catch (error) {
    tracing = false;
    console.error('LangSmith trace failed', error);
  }

  // Runs are batched and uploaded on a timer. This response ends before that
  // timer, so flush once the answer is already on the wire.
  let flushAfterResponse = false;
  const flushTrace = async () => {
    try {
      await trace.client.flush();
      await trace.client.awaitPendingTraceBatches();
    } catch (error) {
      console.error('LangSmith trace failed', error);
    }
  };
  try {
    after(flushTrace);
    flushAfterResponse = true;
  } catch (error) {
    console.error('LangSmith trace failed', error);
  }

  const inTrace = <T>(fn: () => T | Promise<T>) =>
    tracing ? withRunTree(trace, fn) : Promise.resolve(fn());

  const retrieval = await inTrace(() => generateText({
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
        execute: traceable(
          async ({ query }) => {
            const { embedding } = await embed({
              model: openai.embedding('text-embedding-3-small'),
              value: query,
            });
            const hits = await index.query({
              vector: embedding,
              topK: 3,
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
          { name: 'getInformation', run_type: 'retriever' },
        ),
      }),
    },
    maxSteps: 1,
  }));

  if (retrieval.toolCalls.length === 0) {
    if (tracing) {
      try {
        await trace.end({ text: retrieval.text });
        await trace.patchRun();
        if (!flushAfterResponse) await flushTrace();
      } catch (error) {
        console.error('LangSmith trace failed', error);
      }
    }
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
    async execute(dataStream) {
      await inTrace(async () => {
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

        let closed = false;
        const closeTrace = async (text?: string, error?: string) => {
          if (closed || !tracing) return;
          closed = true;
          try {
            await trace.end(text === undefined ? undefined : { text }, error);
            await trace.patchRun();
            if (!flushAfterResponse) await flushTrace();
          } catch (traceError) {
            console.error('LangSmith trace failed', traceError);
          }
        };

        const answer = streamText({
          model: openai('gpt-4o-mini'),
          system,
          messages: appendResponseMessages({
            messages,
            responseMessages: retrieval.response.messages,
          }),
          toolChoice: 'none',
          onFinish: async ({ text }) => {
            await closeTrace(text);
          },
          onError: async ({ error }) => {
            const message = error instanceof Error ? error.message : String(error);
            await closeTrace(undefined, message);
          },
        });
        answer.mergeIntoDataStream(dataStream);
      });
    },
  });
}
