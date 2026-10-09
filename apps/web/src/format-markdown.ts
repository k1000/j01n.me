import { marked, Renderer } from "marked";
import { escapeHtml } from "./format";

const SHARED_STYLES = `
  :root { color-scheme: light dark; --highlight: #fff1d7; }
  body {
    max-width: 760px;
    margin: 0 auto;
    padding: 4rem 1.25rem;
    font-family: "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    line-height: 1.72;
    color: color-mix(in srgb, CanvasText 78%, Canvas 22%);
  }
  h1 { color: CanvasText; font-weight: 700; font-size: clamp(2.5rem, 8vw, 4.5rem); line-height: 1; margin: 0 0 1rem; }
  body > h1::before { content: "# "; color: var(--highlight); }
  h3::before { content: "### "; color: var(--highlight); }
  body > header hgroup { display: grid; grid-template-columns: minmax(0, max-content) minmax(16rem, 1fr); align-items: end; gap: 2rem; margin: 0 0 1rem; }
  body > header h1 { color: var(--highlight); font-size: clamp(3rem, 10vw, 6rem); margin: 0; }
  body > header h1 b { color: CanvasText; font: inherit; }
  body > header p { justify-self: end; text-align: right; margin: 0; max-width: 28rem; font-size: 1.35rem; font-weight: 700; }
  @media (max-width: 720px) {
    body > header hgroup { grid-template-columns: 1fr; gap: 1rem; }
    body > header p { justify-self: start; text-align: left; }
  }
  h2 { color: CanvasText; margin-top: 2.5rem; }
  h3 { color: #fff; }
  strong { color: #fff; }
  .md-marker { color: var(--highlight); font-weight: 500; }
  li::marker { color: var(--highlight); }
  ul { list-style: none; padding-left: 1.35rem; }
  ul > li { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); column-gap: 0.25rem; align-items: start; }
  .md-bullet { color: var(--highlight); }
  code, pre { font-family: inherit; }
  code { padding: 0.12rem 0.3rem; background: transparent; color: var(--highlight); }
  pre { padding: 1rem; overflow: auto; background: #000; color: var(--highlight); }
  pre code { padding: 0; background: transparent; color: inherit; }
  mark, .highlight { background: transparent; color: var(--highlight); }
  .fineprint, body > footer { opacity: 0.72; font-size: 0.95rem; }
  body > footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px dashed color-mix(in srgb, currentColor 22%, transparent); }
  .warning { border: 2px dashed color-mix(in srgb, currentColor 38%, transparent); padding: 1rem; background: color-mix(in srgb, CanvasText 8%, Canvas 92%); }
  .card, main > article { margin-top: 2rem; border: 2px dashed color-mix(in srgb, currentColor 38%, transparent); padding: 1.25rem; background: color-mix(in srgb, CanvasText 8%, Canvas 92%); }
  .rally-flag { margin: 1.5rem 0 0; padding: 0.85rem 1rem; background: var(--highlight); color: #000; font-weight: 700; text-align: center; text-transform: uppercase; letter-spacing: 0.08em; }
  .button { display: inline-block; margin: 1rem 0; padding: 0.8rem 1rem; border: 2px solid var(--highlight); border-radius: 0; background: var(--highlight); color: #000; text-decoration: none; font: inherit; font-weight: 700; cursor: pointer; }
  [data-close-create-room], [data-close-join-room] { background: #000; border-color: #000; color: var(--highlight); }
  .gateway { margin-top: 2.5rem; }
  .gateway > input { position: absolute; opacity: 0; pointer-events: none; }
  .gate-tabs { display: flex; width: 100%; margin-bottom: 0; }
  .gate-tab { flex: 1 1 0; display: block; padding: 0.8rem 1rem; border: 2px solid var(--highlight); background: transparent; color: var(--highlight); cursor: pointer; font-weight: 700; text-align: center; }
  .gate-tab + .gate-tab { border-left: 0; }
  .gate-panels { border: 2px solid var(--highlight); border-top: 0; padding: 1.25rem; background: color-mix(in srgb, CanvasText 8%, Canvas 92%); }
  .gateway .gate-panel { display: none; }
  #gate-humans:checked ~ .gate-panels .gate-panel-humans,
  #gate-bots:checked ~ .gate-panels .gate-panel-bots { display: block; }
  #gate-humans:focus-visible ~ .gate-tabs label[for="gate-humans"],
  #gate-bots:focus-visible ~ .gate-tabs label[for="gate-bots"] { outline: 2px solid currentColor; outline-offset: 3px; }
  #gate-humans:checked ~ .gate-tabs label[for="gate-humans"],
  #gate-bots:checked ~ .gate-tabs label[for="gate-bots"] { background: var(--highlight); color: #000; }
  .gate-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .gate-panel-humans .gate-actions { justify-content: space-between; }
  .gate-actions .button { margin: 0; }
  dialog { max-width: min(42rem, calc(100% - 2rem)); border: 2px solid var(--highlight); border-radius: 0; padding: 1.25rem; background: Canvas; color: CanvasText; }
  dialog::backdrop { background: rgb(0 0 0 / 0.72); }
  dialog h2 { margin-top: 0; }
  dialog form { display: grid; gap: 0.75rem; }
  .field { display: grid; grid-template-columns: minmax(10rem, max-content) minmax(0, 1fr); align-items: center; gap: 1rem; margin: 0 0 0.85rem; }
  .field:has(textarea) { align-items: start; }
  .field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  .field-row .field { grid-template-columns: minmax(0, max-content) minmax(8rem, 1fr); margin-bottom: 0.85rem; }
  @media (max-width: 720px) { .field, .field-row .field { grid-template-columns: 1fr; gap: 0.35rem; } .field-row { grid-template-columns: 1fr; gap: 0; } }
  input, textarea, select { width: 100%; box-sizing: border-box; border: 2px solid color-mix(in srgb, currentColor 38%, transparent); border-radius: 0; padding: 0.7rem; background: Canvas; color: CanvasText; font: inherit; }
  fieldset.template-selector { border: none; padding: 0; margin: 0 0 1rem; }
  fieldset.template-selector legend { font-size: 0.95rem; opacity: 0.72; margin-bottom: 0.5rem; }
  .radio { display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; cursor: pointer; }
  .radio input[type="radio"] { width: auto; margin: 0; accent-color: var(--highlight); }
  textarea { min-height: 7rem; resize: vertical; }
  .dialog-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: end; margin-bottom: 0; }
  .invite-result { display: none; margin-top: 1rem; }
  .invite-result.is-visible { display: block; }
  .invite-json { min-height: 12rem; }
  a { color: var(--highlight); }
  blockquote { border-left: 3px solid currentColor; margin-left: 0; padding-left: 1rem; opacity: 0.85; }
`;

const SITE_URL = "https://j01n.me/";
const SOURCE_URL = "https://gitlab.com/k1000/j01n.me";
const SHARE_TEXT = "j01n.me — free ephemeral encrypted coordination rooms for AI agents";
const SITE_DESCRIPTION =
  "Free ephemeral encrypted coordination rooms for independent AI agents. No accounts, no persistent rooms, no message history.";
const ENCODED_SITE_URL = encodeURIComponent(SITE_URL);
const ENCODED_SHARE_TEXT = encodeURIComponent(SHARE_TEXT);

const COMMON_FOOTER = `<footer>
  <p>j01n.me keeps coordination temporary: no accounts, no persistent rooms, no message history.</p>
  <p>
    <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">GitLab</a>
    · <a href="https://twitter.com/intent/tweet?url=${ENCODED_SITE_URL}&text=${ENCODED_SHARE_TEXT}" target="_blank" rel="noopener noreferrer">Share on X</a>
    · <a href="https://www.linkedin.com/sharing/share-offsite/?url=${ENCODED_SITE_URL}" target="_blank" rel="noopener noreferrer">Share on LinkedIn</a>
    · <a href="https://news.ycombinator.com/submitlink?u=${ENCODED_SITE_URL}&t=${ENCODED_SHARE_TEXT}" target="_blank" rel="noopener noreferrer">Share on Hacker News</a>
  </p>
</footer>`;

/** Chrome origin trial token for WebMCP on https://j01n.me (expires 2027-03-30). Drop once WebMCP ships unflagged. */
const WEBMCP_ORIGIN_TRIAL_TOKEN =
  "AjBzxQ53yGgzU6gbd4vOb322MJFY0SW+RAEZjBZjv7JfVoxyVZiTA1T38dj74igSicrXuKaAMUvO6E3pQqb2LQMAAABaeyJvcmlnaW4iOiJodHRwczovL2owMW4ubWU6NDQzIiwiZmVhdHVyZSI6IldlYk1DUCIsImV4cGlyeSI6MTgwNjM2NDgwMCwiaXNTdWJkb21haW4iOnRydWV9";

export function renderPage(title: string, body: string, extraStyles?: string): string {
  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(SITE_DESCRIPTION);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="origin-trial" content="${WEBMCP_ORIGIN_TRIAL_TOKEN}" />
    <title>${escapedTitle}</title>
    <meta name="description" content="${escapedDescription}" />
    <link rel="canonical" href="${SITE_URL}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="j01n.me" />
    <meta property="og:title" content="${escapedTitle}" />
    <meta property="og:description" content="${escapedDescription}" />
    <meta property="og:url" content="${SITE_URL}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapedTitle}" />
    <meta name="twitter:description" content="${escapedDescription}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet" />
    <style>${SHARED_STYLES}${extraStyles ?? ""}</style>
  </head>
  <body>
    ${body}
    ${COMMON_FOOTER}
  </body>
</html>`;
}

/** Build a custom markdown renderer that injects literal `##` and `*` markers. */
function buildMarkdownRenderer(): Renderer {
  const renderer = new Renderer();

  const origHeading = renderer.heading.bind(renderer);
  renderer.heading = function (token) {
    if (token.depth === 2) {
      return `<h2><span class="md-marker">##</span> ${this.parser.parseInline(token.tokens)}</h2>\n`;
    }
    return origHeading(token);
  };

  const origList = renderer.list.bind(renderer);
  renderer.list = function (token) {
    if (token.ordered) return origList(token);
    const items = token.items.map((item) => this.listitem(item)).join("");
    return `<ul class="md-list">\n${items}</ul>\n`;
  };

  const origListitem = renderer.listitem.bind(renderer);
  renderer.listitem = function (token) {
    if (token.task || token.loose) return origListitem(token);
    const raw = this.parser.parse(token.tokens);
    // Strip <p> tags that parse adds for block-level rendering
    const content = raw.replace(/<\/?p>\n?/g, "");
    return `<li><span class="md-bullet" aria-hidden="true">*</span><span>${content}</span></li>\n`;
  };

  return renderer;
}

/** Parse markdown through the custom renderer that injects literal `##` and `*` markers. */
export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { renderer: buildMarkdownRenderer() }) as string;
}

export function renderMarkdownPage(title: string, markdown: string, extraHtml?: string): string {
  return renderPage(title, (extraHtml ? `${extraHtml}\n` : "") + renderMarkdown(markdown));
}
