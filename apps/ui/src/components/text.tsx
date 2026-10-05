import { Fragment, type ReactNode } from 'react';

/** `**bold**` and `` `code` `` inside a line. Everything else is plain text; nothing is ever interpreted as HTML. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith('**') ? (
        <strong key={i++} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code key={i++} className="rounded bg-hover px-1 py-px font-mono text-[0.92em]">
          {tok.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The little bit of Markdown agents and people actually write in questions and summaries: paragraphs, "- " lists,
 * bold and code. A full Markdown renderer arrives with the artifact viewers.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className={className}>
      {blocks.map((b, bi) => {
        const lines = b.split('\n');
        const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
        return isList ? (
          <ul key={bi} className="my-2 list-disc space-y-1 pl-5">
            {lines.map((l, li) => (
              <li key={li}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
            ))}
          </ul>
        ) : (
          <p key={bi} className="my-2 first:mt-0 last:mb-0">
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
