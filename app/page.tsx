'use client';

import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

type Source = {
  text?: string;
  page?: number;
  score?: number;
  source?: string;
  title?: string;
  topics?: string;
};

function citationTitle(source?: string, title?: string): string {
  if (title) return title;
  if (!source) return 'Unknown document';
  return source.replace(/\.pdf$/i, '').replace(/_/g, ' ');
}

type PassageBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'label'; label: string; text: string }
  | { kind: 'item'; text: string }
  | { kind: 'text'; text: string };

const SECTION_HEADINGS =
  'Quick troubleshooting reference|Suggested wording for the user|Common symptoms|Information to collect|Resolution steps|Resolution and closure|Preventing repeat tickets|Related instructions|Analyst checklist|Worked example|Ticket note field|Escalate when|Good practice|Do not|Scope|Do';

const INLINE_HEADINGS = SECTION_HEADINGS.replace(/\|Do not\|Scope\|Do$/, '|Scope');

const LIST_HEADINGS = new Set([
  'common symptoms',
  'information to collect',
  'escalate when',
  'resolution and closure',
  'preventing repeat tickets',
  'analyst checklist',
  'good practice',
  'do',
  'do not',
]);

function breakSentences(value: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') inQuote = !inQuote;
    const next = value[i + 1];
    const after = value[i + 2];
    if (!inQuote && /[.!?]/.test(ch) && /\s/.test(next ?? '') && /[A-Z]/.test(after ?? '')) {
      out += `${ch}\n`;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function parsePassage(raw: string | undefined, title: string): PassageBlock[] {
  if (!raw?.trim()) return [];

  const shortTitle = title.replace(/^WI-(\d+)\s+/i, '$1 ');
  const titlePrefix = new RegExp(
    `^(?:WI-)?${shortTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`,
    'i',
  );

  const text = raw
    .replace(/\u007f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/-(\n)(?=[A-Za-z])/g, '')
    .replace(/IT Helpdesk Work Instructions/gi, '\n')
    .replace(/Internal use\.\s*Verify against the current version before use\./gi, '')
    .replace(/\bPage \d+ of \d+\b/gi, '')
    .replace(titlePrefix, '')
    .replace(new RegExp(`(^|\\s+)(${INLINE_HEADINGS})(?=\\s|$)`, 'g'), '\n$2\n')
    .replace(
      /\s+((?:Default priority|Target response \/ resolution|Handled by|Related instructions|Issue reported|Checks performed|Action taken|Cause|Result):)/g,
      '\n$1',
    )
    .replace(/(Symptom\s+Likely cause\s+What to do)\s+/i, '$1\n')
    .replace(/\s+([1-9])\s+(?=[A-Z][a-z])/g, '\n$1 ')
    .replace(/\s+(Open|During|Close)\s+(?=")/g, '\n$1 ')
    .replace(/\s+\[\s*\]\s+/g, '\n')
    .replace(/\s+(Do not|Do)(?=\s*(?:\n|$))/g, '\n$1\n');
  const cleaned = breakSentences(text).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ');

  const blocks: PassageBlock[] = [];
  let listMode = false;
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^v\d+\.\d+$/i.test(line) || /^WI-\d+\s*\|/i.test(line)) continue;

    const heading = line.match(new RegExp(`^(${SECTION_HEADINGS})$`, 'i'));
    if (heading) {
      const name = heading[1];
      listMode = LIST_HEADINGS.has(name.toLowerCase());
      blocks.push({ kind: 'heading', text: name });
      continue;
    }
    if (/^Symptom\s+Likely cause\s+What to do$/i.test(line)) {
      listMode = true;
      blocks.push({ kind: 'heading', text: 'Symptom · Likely cause · What to do' });
      continue;
    }
    const labeled =
      line.match(
        /^(Default priority|Target response \/ resolution|Handled by|Related instructions|Issue reported|Checks performed|Action taken|Cause|Result):\s*(.*)$/i,
      ) || line.match(/^(Open|During|Close)\s+(".*)$/);
    if (labeled) {
      listMode = false;
      blocks.push({ kind: 'label', label: labeled[1], text: labeled[2] });
      continue;
    }
    if (listMode || /^[1-9]\s+\S/.test(line)) {
      blocks.push({ kind: 'item', text: line });
      continue;
    }
    const previous = blocks[blocks.length - 1];
    if (previous?.kind === 'item' && /^[1-9]\s/.test(previous.text)) {
      previous.text = `${previous.text} ${line}`;
      continue;
    }
    blocks.push({ kind: 'text', text: line });
  }
  return blocks;
}

function CitationCard({ src, rank }: { src: Source; rank: number }) {
  const title = citationTitle(src.source, src.title);
  const match = typeof src.score === 'number' ? `${Math.round(src.score * 100)}% match` : null;
  const blocks = parsePassage(src.text, title);

  return (
    <li className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-bold leading-snug text-desk-ink">
          <span className="mr-2 text-desk-teal">{rank}.</span>
          {title}
        </p>
        <p className="shrink-0 text-right text-xs leading-5 text-slate-500">
          Page {src.page ?? '?'}
          {match && <span className="mt-0.5 block font-semibold text-desk-blue">{match}</span>}
        </p>
      </div>
      {blocks.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2 text-sm leading-relaxed text-slate-700">
          {blocks.map((block, index) => {
            if (block.kind === 'heading') {
              return (
                <p key={index} className="pt-1 text-xs font-bold uppercase tracking-wide text-desk-teal">
                  {block.text}
                </p>
              );
            }
            if (block.kind === 'label') {
              return (
                <p key={index}>
                  <span className="font-semibold text-desk-blue">{block.label}. </span>
                  {block.text}
                </p>
              );
            }
            if (block.kind === 'item') {
              const numbered = /^[1-9]\s/.test(block.text);
              return (
                <p key={index} className={numbered ? 'pl-1' : 'pl-4'}>
                  {numbered ? block.text : `• ${block.text}`}
                </p>
              );
            }
            return <p key={index}>{block.text}</p>;
          })}
        </div>
      )}
    </li>
  );
}

type ToolInvocation = {
  state: string;
  toolName: string;
  toolCallId: string;
  result?: Source[];
};

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user' | 'system' | 'data';
  content: string;
  toolInvocations?: ToolInvocation[];
  parts?: Array<{ type: string; toolInvocation?: ToolInvocation }>;
};

function collectSourceGroups(message: ChatMessage): { id: string; sources: Source[] }[] {
  const fromInvocations = (message.toolInvocations ?? []).filter(
    (inv) => inv.state === 'result' && inv.toolName === 'getInformation' && Array.isArray(inv.result),
  );
  const invocations =
    fromInvocations.length > 0
      ? fromInvocations
      : (message.parts ?? [])
          .filter((part) => part.type === 'tool-invocation' && part.toolInvocation)
          .map((part) => part.toolInvocation as ToolInvocation)
          .filter(
            (inv) =>
              inv.state === 'result' && inv.toolName === 'getInformation' && Array.isArray(inv.result),
          );
  return invocations.map((inv) => ({ id: inv.toolCallId, sources: inv.result ?? [] }));
}

const markdownComponents = {
  p: ({ children }: { children?: ReactNode }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="pl-1">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-bold text-desk-blue">{children}</strong>
  ),
  h1: ({ children }: { children?: ReactNode }) => (
    <h2 className="mb-2 text-base font-bold text-desk-blue">{children}</h2>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-2 text-sm font-bold text-desk-blue">{children}</h3>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h4 className="mb-2 text-sm font-bold text-desk-ink">{children}</h4>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} className="font-semibold text-desk-teal underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="max-w-[85%] rounded-2xl border border-slate-200 border-l-4 border-l-desk-teal bg-white px-4 py-3 text-sm leading-relaxed [&_li>p]:mb-0 [&_li>p]:inline">
      <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
    </div>
  );
}

const greeting = {
  id: 'greeting',
  role: 'assistant' as const,
  content: `Hey. I'm **AI-Tee**, your AI buddy for IT helpdesk concerns. Hold music not included.

Bring me the usual suspects:

- Locked accounts, forgotten passwords, and mystery error codes
- Email, Wi-Fi, VPN, and the classic "it worked yesterday"
- Printers, software, and what to try before you open a ticket

Ask in plain language. I'll lead with the fix. Open **Sources** under the reply to see the work instruction it came from.`,
};

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, status, error } = useChat({
    api: '/api/chat',
    initialMessages: [greeting],
  });
  const busy = status === 'streaming' || status === 'submitted';
  const savedSources = useRef<Map<number, { id: string; sources: Source[] }[]>>(new Map());
  const listRef = useRef<HTMLUListElement>(null);

  const chatMessages = messages as ChatMessage[];
  chatMessages.forEach((message, index) => {
    const groups = collectSourceGroups(message);
    if (groups.length > 0) savedSources.current.set(index, groups);
  });

  const lastMessage = chatMessages.at(-1);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [lastMessage?.content, chatMessages.length, busy]);

  return (
    <div className="flex h-screen flex-col">
      <header className="bg-desk-ink text-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-wide text-desk-amber">AI-Tee</h1>
            <p className="mt-1 text-base font-semibold text-slate-100">
              Your AI buddy for IT helpdesk concerns
            </p>
          </div>
          <img
            src="/aitee-logo.jpg"
            alt="AI-Tee"
            className="h-24 w-24 shrink-0 rounded-full bg-white object-cover"
          />
        </div>
      </header>
      <div className="h-1.5 bg-desk-teal" aria-hidden="true" />

      <main className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col px-6 py-6">
        <ul ref={listRef} className="mb-6 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {chatMessages.map((m, index) => {
            const sourceGroups =
              m.role === 'assistant' ? (savedSources.current.get(index) ?? []) : [];
            return (
            <li
              key={`${m.role}-${index}`}
              className={
                m.role === 'user'
                  ? 'flex justify-end'
                  : 'flex flex-col items-start justify-start'
              }
            >
              {m.role === 'user' ? (
                <span className="inline-block max-w-[85%] rounded-2xl bg-desk-blue px-4 py-2 text-white">
                  {m.content}
                </span>
              ) : (
                m.content && <AssistantMessage content={m.content} />
              )}

              {sourceGroups.map((group) => (
                <details
                  key={group.id}
                  className="mt-2 w-full max-w-[85%] text-sm text-slate-600"
                >
                  <summary className="inline-block cursor-pointer rounded-full bg-desk-teal px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
                    Sources ({group.sources.length})
                  </summary>
                  <ol className="mt-2 space-y-2">
                    {group.sources.map((src, i) => (
                      <CitationCard key={i} src={src} rank={i + 1} />
                    ))}
                  </ol>
                </details>
              ))}
            </li>
            );
          })}
          {busy && !messages.at(-1)?.content && (
            <li className="text-sm font-semibold text-desk-teal">…</li>
          )}
          {error && (
            <li className="text-sm font-semibold text-desk-coral">
              Error: {error.message}
            </li>
          )}
        </ul>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            className="flex-1 rounded-full border border-slate-300 bg-white px-4 py-2 focus:border-desk-teal focus:outline-none"
            placeholder="Printer on strike? VPN ghosting you? Ask away…"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={!input || busy}
            className="rounded-full bg-desk-teal px-5 py-2 font-bold text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
        <p className="mt-3 text-center text-xs text-slate-500">
          General IT guidance. Confirm anything that changes access, data, or company policy.
        </p>
      </main>
    </div>
  );
}
