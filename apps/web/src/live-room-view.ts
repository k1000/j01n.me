export const LIVE_ROOM_STYLES = `
  .room-navigation { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .room-navigation .button { margin: 0; padding: 0.65rem 1rem; }
  body.live-room-page {
    --live-bg: #121212;
    --live-soft: #1b1a17;
    --live-ink: #e6e2d9;
    --live-heading: #ffffff;
    --live-muted: #aaa69b;
    --live-line: #49443b;
    --live-accent: #ffebc4;
    --live-success: #b6d88d;
    --live-amber: #edc36e;
    --live-gap: 2rem;
    --live-mono: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
    color-scheme: dark;
    max-width: 1440px;
    padding: 3rem clamp(1rem, 3vw, 3rem);
    background: var(--live-bg);
    color: var(--live-ink);
    font-family: var(--live-mono);
    line-height: 1.7;
  }
  body.live-room-page *, body.live-room-page *::before, body.live-room-page *::after { box-sizing: border-box; border-radius: 0; box-shadow: none; }
  .live-room-page a { color: var(--live-accent); }
  .live-room-page .room-navigation > a:first-child { font-weight: 700; text-decoration: none; }
  .live-room-page .room-navigation .button { min-height: 44px; border: 1px solid var(--live-accent); background: transparent; color: var(--live-accent); font-size: 0.8rem; }
  .live-room-page a:focus-visible, .live-room-page summary:focus-visible, .live-room-page button:focus-visible { outline: 2px solid var(--live-accent); outline-offset: 4px; }
  .live-room-page [data-room-root] { margin-top: 3rem; }
  .live-room-page [data-room-error] { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px dashed var(--live-amber); color: var(--live-amber); }
  .live-room-page [data-room-error] .button { min-height: 44px; margin: 0; padding: 0.4rem 0.7rem; border: 1px solid currentColor; background: transparent; color: inherit; }
  .live-room-page footer { color: var(--live-muted); border-color: var(--live-line); opacity: 1; font-size: 0.75rem; }
  .live-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: var(--live-gap); margin-bottom: 2rem; }
  .live-header > div:first-child { min-width: 0; flex: 1 1 30rem; }
  .live-header h1 { margin: 0.75rem 0 1rem; color: var(--live-accent); font-size: clamp(2rem, 4vw, 3.5rem); font-weight: 700; letter-spacing: -0.045em; line-height: 1.15; overflow-wrap: anywhere; }
  .live-header p { margin: 0; max-width: 66ch; color: var(--live-ink); font-size: 0.85rem; }
  .live-eyebrow { color: var(--live-muted); font-size: 0.65rem; letter-spacing: 0.12em; text-transform: uppercase; }
  .live-connection { display: grid; justify-items: end; gap: 0.35rem; padding-top: 0.15rem; }
  .live-connection small { color: var(--live-muted); font-size: 0.65rem; }
  .live-room-page .connection-status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0; border: 0; background: transparent; color: var(--live-muted); font-size: 0.7rem; }
  .live-room-page .connection-dot { width: 0.35rem; height: 0.35rem; background: currentColor; }
  .live-room-page .connection-status.connected { color: var(--live-success); }
  .live-room-page .connection-status.connecting, .live-room-page .connection-status.stale { color: var(--live-amber); }
  @media (prefers-reduced-motion: reduce) { .live-room-page * { animation: none !important; } }
  .live-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1.5rem; margin: 0 0 2.5rem; padding: 1rem 1.25rem; background: var(--live-accent); color: var(--live-bg); }
  .live-stats > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 0.75rem; }
  .live-stats dt { font-size: 0.65rem; font-weight: 600; }
  .live-stats dd { margin: 0; font-size: 1rem; font-weight: 700; overflow-wrap: anywhere; }
  .live-grid { display: grid; grid-template-columns: minmax(0, 2.25fr) minmax(260px, 1fr); gap: var(--live-gap); align-items: start; }
  .live-panel { min-width: 0; border-top: 1px solid var(--live-line); background: transparent; }
  .live-panel:first-child { border: 1px solid var(--live-accent); }
  .live-panel:nth-child(3) { border: 1px dashed var(--live-line); background: var(--live-soft); }
  .live-panel > header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 1rem 1.25rem; border-bottom: 1px dashed var(--live-line); }
  .live-panel h2 { margin: 0; color: var(--live-heading); font-size: 0.95rem; font-weight: 700; }
  .live-marker { color: var(--live-accent); }
  .live-panel > header > span { color: var(--live-muted); font-size: 0.65rem; }
  .live-panel-body { padding: 1.25rem; }
  .live-empty { margin: 0; padding: 1rem 0; color: var(--live-muted); font-size: 0.85rem; }
  .live-board-entries { display: grid; grid-template-columns: minmax(0, 1fr); }
  .live-board-card { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 2.5fr); gap: 0.5rem 1.5rem; min-width: 0; padding: 1rem 0; border-top: 1px dashed var(--live-line); background: transparent; }
  .live-board-card > header { display: flex; flex-wrap: wrap; align-content: start; align-items: baseline; gap: 0.5rem; }
  .live-board-card h3 { margin: 0; color: var(--live-accent); font-size: 0.75rem; font-weight: 500; overflow-wrap: anywhere; }
  .live-board-card h3::before { content: none; }
  .live-version, .live-board-card small { color: var(--live-muted); font-size: 0.6rem; }
  .live-board-card small { grid-column: 2; }
  .live-board-card pre { margin: 0; padding: 0; background: transparent; color: var(--live-ink); font: inherit; font-size: 0.75rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .live-room-page .kanban-board { gap: 0; margin: 0; padding-bottom: 1rem; }
  .live-room-page .kanban-column { min-width: 0; padding: 0 0.75rem; border-left: 1px dashed var(--live-line); background: transparent; }
  .live-room-page .kanban-column:first-child { padding-left: 0; border-left: 0; }
  .live-room-page .kanban-column-title { opacity: 1; color: var(--live-muted); font-size: 0.6rem; font-weight: 500; }
  .live-room-page .kanban-column-title::before { content: none; }
  .live-room-page .kanban-card { padding: 0.4rem 0; border: 0; background: transparent; color: var(--live-ink); overflow-wrap: anywhere; }
  .live-room-page .kanban-card-title { font-size: 0.75rem; font-weight: 500; }
  .live-room-page .kanban-card-owner { opacity: 1; color: var(--live-muted); font-size: 0.6rem; }
  .live-people { display: grid; gap: 0; }
  .live-person { padding: 0.75rem 0; border-bottom: 1px dashed var(--live-line); }
  .live-person:first-child { padding-top: 0; }
  .live-person:last-child { padding-bottom: 0; border-bottom: 0; }
  .live-person header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; }
  .live-person strong { color: var(--live-accent); font-size: 0.75rem; font-weight: 500; overflow-wrap: anywhere; }
  .live-person p { margin: 0.25rem 0; color: var(--live-ink); font-size: 0.7rem; overflow-wrap: anywhere; }
  .live-person small { color: var(--live-muted); font-size: 0.6rem; }
  .live-state { color: var(--live-muted); font-size: 0.6rem; }
  .live-state::before { content: "["; }
  .live-state::after { content: "]"; }
  .live-state[data-state="free"] { color: var(--live-success); }
  .live-state[data-state="busy"] { color: var(--live-amber); }
  .live-room-page .message-entry { padding: 1rem 1.25rem; border: 0; border-bottom: 1px dashed var(--live-line); }
  .live-room-page .message-entry:last-child { border-bottom: 0; }
  .live-room-page .message-entry summary { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 2.5fr); gap: 0.35rem 1.5rem; align-items: baseline; }
  .live-room-page .message-from { color: var(--live-accent); font-size: 0.7rem; font-weight: 500; }
  .live-room-page .message-time { display: block; opacity: 1; color: var(--live-muted); font-size: 0.6rem; }
  .live-room-page .message-body { grid-column: 2; grid-row: 1 / span 2; margin: 0; font-size: 0.75rem; }
  .live-room-page .message-route { grid-column: 1; grid-row: 2; margin: 0; color: var(--live-muted); font-size: 0.6rem; overflow-wrap: anywhere; }
  .live-room-page .message-technical { margin: 0.75rem 0 0; padding: 0.75rem 0; border-top: 1px dashed var(--live-line); background: transparent; color: var(--live-muted); opacity: 1; font-size: 0.65rem; }
  .live-activity { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
  .live-activity > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.75rem; }
  .live-activity span { color: var(--live-ink); font-size: 0.7rem; overflow-wrap: anywhere; }
  .live-activity time { color: var(--live-muted); font-size: 0.6rem; }
  .live-privacy { margin: 2rem 0 0; padding-top: 1rem; border-top: 1px dashed var(--live-line); color: var(--live-muted); font-size: 0.65rem; }
  @media (max-width: 900px) { .live-grid { grid-template-columns: minmax(0, 1fr); } .live-connection { justify-items: start; } }
  @media (max-width: 600px) {
    .live-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .live-room-page .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 0; }
    .live-room-page .kanban-column:nth-child(odd) { padding-left: 0; border-left: 0; }
    .live-board-card { grid-template-columns: minmax(0, 1fr); gap: 0.5rem; }
    .live-board-card small { grid-column: 1; }
    .live-room-page .message-entry summary { display: block; }
    .live-room-page .message-route { display: block; margin: 0.25rem 0 0.5rem; }
  }
`;
