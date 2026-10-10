export const ROOM_CONSOLE_STYLES = String.raw`
  body.room-console-page { color-scheme: dark; --console-ink: #121212; --console-panel: #1d1c1a; --console-cream: #ffebc4; --console-rule: #5f584b; background: var(--console-ink); color: var(--console-cream); max-width: 1200px; padding: 2rem 1.25rem; }
  .room-console-page h1, .room-console-page h2, .room-console-page h3, .room-console-page a { color: var(--console-cream); }
  .room-console-page h1 { font-size: clamp(1.75rem, 5vw, 3rem); overflow-wrap: anywhere; }
  .room-console-page h3::before { content: none; }
  .room-console-page .room-navigation { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .room-console-page input, .room-console-page textarea, .room-console-page select { min-width: 0; background: var(--console-ink); color: var(--console-cream); border: 1px solid var(--console-rule); }
  .room-console-page .button { color: var(--console-ink); background: var(--console-cream); border: 1px solid var(--console-cream); min-height: 44px; }
  .room-console-page :focus-visible { outline: 2px dashed var(--console-cream); outline-offset: 3px; }
  .room-console-page :disabled { opacity: 0.65; cursor: wait; }
  .room-console-page .room-meta { grid-template-columns: max-content minmax(0, 1fr); }
  .room-console-page .room-meta dd { min-width: 0; overflow-wrap: anywhere; }
  .room-console-page .room-meta code { overflow-wrap: anywhere; }
  .room-console-page .room-kickoff { white-space: pre-wrap; }
  /* Invitation link and its Copy button share a row; the button wraps under the link on narrow screens. */
  .room-console-page .invite-copy { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: stretch; }
  .room-console-page .invite-copy input { flex: 1 1 16rem; min-width: 0; }
  .room-console-page .invite-copy .button { flex: none; margin: 0 0 0 auto; }
  .room-console-page .room-board { padding: 1.25rem; background: var(--console-panel); color: var(--console-cream); border: 1px dashed var(--console-rule); }
  .room-console-page .room-board h2 { margin-top: 0; }
  .room-console-page .board-entry .board-key { color: var(--console-cream); }
  .room-console-page .board-entry pre { color: var(--console-cream); background: var(--console-ink); }
  .room-console-page .board-edit-form input, .room-console-page .board-edit-form textarea { background: var(--console-ink); color: var(--console-cream); }
  .room-console-page .kanban-board { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .room-console-page .kanban-card { background: var(--console-ink); color: var(--console-cream); overflow-wrap: anywhere; }
  .room-console-page .kanban-card p { white-space: pre-wrap; font-size: 0.85rem; }
  .room-console-page .kanban-card .button { font-size: 0.85rem; padding: 0.4rem 0.65rem; margin-bottom: 0; }
  .room-console-page .task-editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem 1rem; padding: 1rem; border: 1px dashed var(--console-rule); }
  .room-console-page .task-editor label { display: grid; gap: 0.25rem; }
  .room-console-page .task-editor .task-wide { grid-column: 1 / -1; }
  .room-console-page [role="status"] { min-height: 1.2em; font-size: 0.9rem; }
  .room-console-page .message-composer, .room-console-page .board-edit-form { border-color: var(--console-rule); }
  .room-console-page [hidden] { display: none !important; }
  .room-console-page .reply-request { display: flex; align-items: center; gap: 0.5rem; min-height: 44px; }
  .room-console-page .reply-request input { width: auto; }
  .room-console-page .message-compose-actions { align-items: center; }
  .room-console-page .message-compose-actions .reply-request { margin-right: auto; } /* checkbox left, buttons right */
  .room-console-page .message-technical { max-height: 16rem; overflow: auto; }
  /* Messages scroll inside their own box; new ones start highlighted and fade (4s, matching MESSAGE_FADE_MS). */
  .room-console-page .message-list { max-height: min(60vh, 36rem); overflow-y: auto; overscroll-behavior: contain; padding: 0 0.75rem; border: 1px dashed var(--console-rule); }
  .room-console-page .message-list:focus-visible { outline-offset: -2px; }
  .room-console-page .message-new { animation: message-arrive 4s ease-out both; }
  @keyframes message-arrive { from { background-color: color-mix(in srgb, var(--console-cream) 22%, transparent); } to { background-color: transparent; } }
  @media (max-width: 760px) { .room-console-page .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 480px) { .room-console-page .kanban-board, .room-console-page .task-editor, .room-console-page .room-meta { grid-template-columns: minmax(0, 1fr); } .room-console-page .room-meta dt { margin-top: 0.5rem; } }
`;
