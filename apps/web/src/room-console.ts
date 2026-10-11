import { HOME_PALETTE } from "./home-page";

export const ROOM_CONSOLE_STYLES = String.raw`
  body.room-console-page {
    color-scheme: dark;
${HOME_PALETTE}
    --console-ink: var(--ink);
    --console-panel: var(--panel);
    --console-cream: var(--cream);
    --console-text: var(--text);
    --console-dim: var(--dim);
    --console-rule: var(--rule);
    --console-ok: var(--ok);
    --highlight: var(--console-cream);
    max-width: 72rem;
    padding: 2.5rem clamp(1rem, 3vw, 3rem) 4rem;
    background: var(--console-ink);
    color: var(--console-text);
    font: 400 0.9375rem/1.7 "Fira Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace;

    & h1, & h2, & h3 { color: #fff; }
    & a { color: var(--console-cream); text-underline-offset: 3px; }
    & :focus-visible { outline: 2px dashed var(--console-cream); outline-offset: 3px; }
    & :disabled { opacity: 0.65; cursor: wait; }
    & [hidden] { display: none !important; }
    & .fineprint, & [role="status"] { color: var(--console-dim); opacity: 1; }
    & code { color: var(--console-cream); overflow-wrap: anywhere; }
    & h3::before { color: var(--console-cream); }
    & [data-room-root] { display: grid; gap: 1.25rem; margin-top: 2.5rem; }
    & [data-room-root] h2 { margin: 0 0 0.8rem; font-size: 1.5rem; line-height: 1.2; }
    & [data-room-root] h2::before { content: "## "; color: var(--console-cream); }

    & .room-navigation { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.75rem 1.25rem; padding-bottom: 1rem; border-bottom: 1px dashed var(--console-rule); }
    & .room-navigation > a:first-child { margin-right: auto; font-size: 1.25rem; font-weight: 700; text-decoration: none; letter-spacing: -0.02em; }
    & .room-navigation .button, & .arcade-toggle { margin: 0; padding: 0.7rem 1rem; min-height: 44px; border: 1px solid var(--console-cream); background: transparent; color: var(--console-cream); font: 700 0.8125rem/1.4 "Fira Code", ui-monospace, monospace; text-decoration: none; cursor: pointer; }
    & .room-navigation .button:hover, & .arcade-toggle:hover, & .arcade-toggle[aria-expanded="true"] { background: var(--console-cream); color: var(--console-ink); }

    & .room-overview { border: 2px solid var(--console-cream); background: var(--console-panel); padding: clamp(1rem, 3vw, 1.75rem); min-width: 0; }
    & .room-overview h1 { margin: 0 0 1.5rem; font-size: clamp(2rem, 5vw, 3.25rem); letter-spacing: -0.04em; line-height: 1.15; overflow-wrap: anywhere; }
    & .room-overview h1::before { content: "# "; color: var(--console-cream); }
    & .connection-status { display: inline-flex; align-items: center; gap: 0.5rem; margin-left: 0.5rem; padding: 0.25rem 0.55rem; border: 1px solid var(--console-rule); vertical-align: middle; font-size: 0.7rem; font-weight: 500; letter-spacing: 0.05em; color: var(--console-cream); }
    & .connection-status.connected { color: var(--console-ok); }
    & .connection-status.disconnected { color: #f0aa9c; }
    & .room-meta { grid-template-columns: max-content minmax(0, 1fr); gap: 0.75rem 1.25rem; padding: 0; border: 0; align-items: baseline; font-size: 0.85rem; }
    & .room-url { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    & .room-url code { margin-right: auto; }
    & .room-meta dt, & .room-summary dt { color: var(--console-dim); opacity: 1; font-size: 0.75rem; letter-spacing: 0.07em; text-transform: uppercase; }
    & .room-meta dd, & .room-summary dd { min-width: 0; margin: 0; color: var(--console-text); overflow-wrap: anywhere; }
    & .room-kickoff { white-space: pre-wrap; }
    & .room-summary { gap: 1rem; margin-top: 1.25rem; padding: 1.25rem 0 0; border-top: 1px dashed var(--console-rule); border-bottom: 0; }
    & .room-summary > div { display: grid; gap: 0.25rem; align-content: start; }
    & .room-summary dd { font-weight: 700; }
    & .room-expiry { margin-top: 0.35rem; }
    & .room-expiry .button { margin: 0; }

    & .button { margin: 0; min-height: 44px; border: 2px solid var(--console-cream); background: var(--console-cream); color: var(--console-ink); }
    & .button:hover { filter: brightness(1.07); }
    & .button.button-small, & .board-edit-actions .button:first-child, & .message-compose-actions .button:not([type="submit"]) { border: 1px solid var(--console-cream); background: transparent; color: var(--console-cream); }
    & input, & textarea, & select { background: var(--console-ink); color: var(--console-text); border: 1px solid var(--console-rule); min-width: 0; }
    & input[readonly] { color: var(--console-cream); }
    & input[type="checkbox"] { width: auto; accent-color: var(--console-cream); }
    & .snippet pre { background: var(--console-ink); color: var(--console-text); border-color: var(--console-rule); }
    & .copy { background: var(--console-cream); color: var(--console-ink); }

    & .room-board { border: 2px solid var(--console-cream); background: var(--console-panel); color: var(--console-text); padding: clamp(1rem, 3vw, 1.5rem); margin: 0; }
    & .room-reservations, & .room-participants, & .room-messages { border: 1px dashed var(--console-rule); background: var(--console-panel); padding: clamp(1rem, 3vw, 1.5rem); margin: 0; min-width: 0; }
    & .room-board h3 { color: #fff; }
    & .board-edit-form, & .task-editor, & .message-composer { border: 1px dashed var(--console-rule); background: var(--console-ink); }
    & .task-editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem 1rem; padding: 1rem; }
    & .task-editor label { display: grid; gap: 0.25rem; }
    & .task-editor .task-wide { grid-column: 1 / -1; }
    & .board-edit-form input, & .board-edit-form textarea, & .kanban-add-task input, & .kanban-add-task select, & .message-composer select, & .message-composer textarea { background: var(--console-ink); color: var(--console-text); border: 1px solid var(--console-rule); }
    & .board-entry { border-color: var(--console-rule); }
    & .board-entry .board-key { color: var(--console-cream); }
    & .board-entry pre { color: var(--console-cream); background: var(--console-ink); }
    & .kanban-column { background: var(--console-ink); border: 1px dashed var(--console-rule); border-top: 2px solid var(--console-cream); padding: 1rem; }
    & .kanban-column-title { color: var(--console-cream); opacity: 1; font-size: 0.75rem; }
    & .kanban-card { background: var(--console-panel); color: var(--console-text); border: 1px solid var(--console-rule); overflow-wrap: anywhere; }
    & .kanban-card p { white-space: pre-wrap; font-size: 0.85rem; }
    & .kanban-card .button { font-size: 0.85rem; padding: 0.4rem 0.65rem; margin-bottom: 0; }
    & .kanban-card-owner { color: var(--console-dim); opacity: 1; }
    & .reservation-list li { border-color: var(--console-rule); }

    & .participant-card { background: var(--console-panel); color: var(--console-text); border-color: var(--console-rule); }
    & .participant-name { color: var(--console-cream); }
    & .participant-state, & .participant-workspace { color: var(--console-dim); opacity: 1; }
    & .participant-badge { color: var(--console-dim); border-color: var(--console-rule); opacity: 1; }
    & .participant-profile { padding-top: 0.5rem; border-top: 1px dashed var(--console-rule); }
    & .participant-model { border-color: var(--console-rule); border-radius: 0; color: var(--console-cream); opacity: 1; }

    & .message-list { max-height: min(60vh, 36rem); overflow-y: auto; overscroll-behavior: contain; padding: 0 1rem; border: 1px dashed var(--console-rule); background: var(--console-ink); }
    & .message-list:focus-visible { outline-offset: -2px; }
    & .message-entry { border-color: var(--console-rule); }
    & .message-entry[class*="message-kind-"] { border-left-color: var(--kind-accent); }
    & .message-entry[class*="message-kind-"] .message-route { color: var(--kind-accent); }
    & .message-entry .message-from { color: var(--console-cream); }
    & .message-entry .message-route, & .message-entry .message-time { color: var(--console-dim); opacity: 1; }
    & .message-entry .message-body { color: var(--console-text); }
    & .message-technical { max-height: 16rem; overflow: auto; color: var(--console-dim); opacity: 1; }
    & .message-composer { margin-bottom: 0; }
    & .message-composer p, & .message-composer .button { margin: 0; }
    & .message-composer [data-reply-status]:empty, & .message-composer .message-compose-status:empty { min-height: 0; }
    & .reply-request { display: flex; align-items: center; gap: 0.5rem; min-height: 44px; }
    & .message-compose-actions { align-items: center; }
    & .message-compose-actions .reply-request { margin-right: auto; }
    & .message-new { animation: message-arrive 4s ease-out both; }

    @media (max-width: 760px) {
      & .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 480px) {
      & .kanban-board, & .task-editor, & .room-meta { grid-template-columns: minmax(0, 1fr); }
      & .task-editor .task-wide { grid-column: 1; }
      & .room-meta dt { margin-top: 0.5rem; }
      & .room-navigation > a:first-child { flex-basis: 100%; }
      & .connection-status { margin: 0.5rem 0 0; }
    }
    @media (prefers-reduced-motion: reduce) { & .message-new { animation: none; } }
  }
  @keyframes message-arrive {
    from { background-color: color-mix(in srgb, var(--console-cream) 4%, var(--console-ink)); outline: 1px solid var(--console-cream); }
    to { background-color: transparent; outline: 1px solid transparent; }
  }
`;
