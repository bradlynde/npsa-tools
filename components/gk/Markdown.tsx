"use client";
import React from "react";

/**
 * A small, safe markdown renderer for knowledge base prose.
 *
 * The text in these fields comes from the team, from Claude, and from web pages
 * Claude read, so it is never handed to the DOM as HTML: everything is built as
 * React elements, and a link is only a link when it is http(s). It covers what the
 * notes actually use: paragraphs, bold, emphasis, code, links and bare URLs,
 * bullet and numbered lists (with checkboxes), blockquotes, small headings and
 * simple tables.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0, i = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0], at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key} style={{ fontWeight: 650, color: "var(--ink)" }}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} className="mono" style={{ fontSize: "0.92em", background: "var(--hover)", padding: "1px 5px", borderRadius: 4 }}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)!;
      out.push(<a key={key} href={mm[2]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)" }}>{mm[1]}</a>);
    } else if (tok.startsWith("http")) out.push(<a key={key} href={tok} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)", wordBreak: "break-word" }}>{tok.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ children, style }: { children?: string | null; style?: React.CSSProperties }) {
  const src = String(children || "").replace(/\r\n/g, "\n").trim();
  if (!src) return null;
  const lines = src.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0, k = 0;
  const p: React.CSSProperties = { margin: "0 0 9px", lineHeight: 1.55 };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^---+\s*$/.test(line)) { i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push(<div key={k++} style={{ fontWeight: 650, color: "var(--ink)", margin: "12px 0 6px", fontSize: h[1].length <= 2 ? 15 : 13.5 }}>{inline(h[2], `h${k}`)}</div>); i++; continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <div key={k++} style={{ overflowX: "auto", margin: "0 0 10px" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%" }}>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => React.createElement(ri === 0 ? "th" : "td", { key: ci, style: { textAlign: "left", padding: "5px 10px 5px 0", borderBottom: "1px solid var(--hair2)", verticalAlign: "top", fontWeight: ri === 0 ? 600 : 400, color: ri === 0 ? "var(--mute)" : undefined } }, inline(c, `t${k}-${ri}-${ci}`)))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={k++} style={{ margin: "0 0 10px", padding: "8px 12px", borderLeft: "3px solid var(--warn-fg)", background: "var(--warn-bg)", borderRadius: "0 8px 8px 0", lineHeight: 1.5 }}>{inline(quote.join(" "), `q${k}`)}</blockquote>);
      continue;
    }

    const bullet = /^\s*([-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (bullet.test(lines[i])) items.push(lines[i].replace(bullet, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push(React.createElement(ordered ? "ol" : "ul", { key: k++, style: { margin: "0 0 10px", paddingLeft: 20, lineHeight: 1.55 } },
        items.map((it, ii) => {
          const box = it.match(/^\[( |x|X)\]\s+(.*)$/);
          return <li key={ii} style={{ marginBottom: 4, listStyle: box ? "none" : undefined, marginLeft: box ? -18 : 0 }}>{box ? <><span aria-hidden="true" className="mono" style={{ marginRight: 7 }}>{box[1] === " " ? "☐" : "☑"}</span>{inline(box[2], `l${k}-${ii}`)}</> : inline(it, `l${k}-${ii}`)}</li>;
        })));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*\|.*\|\s*$)/.test(lines[i]) && !bullet.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={k++} style={p}>{inline(para.join(" "), `p${k}`)}</p>);
  }
  return <div style={{ fontSize: 13.5, color: "var(--sec)", ...style }}>{blocks}</div>;
}
