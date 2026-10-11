export const LIVE_ROOM_STYLES = `
  body.live-room-page {
    --live-bg: var(--console-ink);
    --live-soft: var(--console-panel);
    --live-ink: var(--console-text);
    --live-heading: #ffffff;
    --live-muted: var(--console-dim);
    --live-line: var(--console-rule);
    --live-accent: var(--console-cream);
    --live-success: var(--console-ok);
    --live-amber: #e9bc76;
    --live-gap: 2rem;
    --live-mono: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
    color-scheme: dark;
    max-width: 72rem;
    padding: 2.5rem clamp(1rem, 3vw, 3rem) 4rem;
    background: var(--live-bg);
    color: var(--live-ink);
    font-family: var(--live-mono);
    line-height: 1.7;
    & .room-navigation { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
    & *, & *::before, & *::after { box-sizing: border-box; border-radius: 0; box-shadow: none; }
    & a { color: var(--live-accent); }
    & .room-navigation > a:first-child { font-weight: 700; text-decoration: none; }
    & .room-navigation .button { margin: 0; padding: 0.65rem 1rem; min-height: 44px; border: 1px solid var(--live-accent); background: transparent; color: var(--live-accent); font-size: 0.8rem; }
    & a:focus-visible, & summary:focus-visible, & button:focus-visible { outline: 2px solid var(--live-accent); outline-offset: 4px; }
    & [data-room-root] { margin-top: 3rem; }
    & [data-room-root] h2::before { content: none; }
    & [data-room-error] { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px dashed var(--live-amber); color: var(--live-amber); }
    & [data-room-error] .button { min-height: 44px; margin: 0; padding: 0.4rem 0.7rem; border: 1px solid currentColor; background: transparent; color: inherit; }
    & footer { color: var(--live-muted); border-color: var(--live-line); opacity: 1; font-size: 0.85rem; }
    & .live-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: var(--live-gap); margin-bottom: 2rem; }
    & .live-header > div:first-child { min-width: 0; flex: 1 1 30rem; }
    & .live-header h1 { margin: 0.75rem 0 1rem; color: var(--live-accent); font-size: clamp(2rem, 4vw, 3.5rem); font-weight: 700; letter-spacing: -0.045em; line-height: 1.15; overflow-wrap: anywhere; }
    & .live-header p { margin: 0; max-width: 66ch; color: var(--live-ink); font-size: 0.85rem; }
    & .live-eyebrow { color: var(--live-muted); font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase; }
    & .live-connection { display: grid; justify-items: end; gap: 0.35rem; padding-top: 0.15rem; }
    & .live-connection small { color: var(--live-muted); font-size: 0.75rem; }
    & .connection-status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0; border: 0; background: transparent; color: var(--live-muted); font-size: 0.8125rem; }
    & .connection-dot { width: 0.35rem; height: 0.35rem; background: currentColor; }
    & .connection-status.connected { color: var(--live-success); }
    & .connection-status.connecting, & .connection-status.stale { color: var(--live-amber); }
    @media (prefers-reduced-motion: reduce) { & * { animation: none !important; } }
    & .live-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1.5rem; margin: 0 0 2.5rem; padding: 1rem 1.25rem; background: var(--live-accent); color: var(--live-bg); }
    & .live-stats > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 0.75rem; }
    & .live-stats dt { font-size: 0.75rem; font-weight: 600; }
    & .live-stats dd { margin: 0; font-size: 1rem; font-weight: 700; overflow-wrap: anywhere; }
    & .live-grid { display: grid; grid-template-columns: minmax(0, 2.25fr) minmax(260px, 1fr); gap: var(--live-gap); align-items: start; }
    & section.live-usage { margin-bottom: 2.5rem; border: 1px solid var(--live-accent); }
    & .live-usage-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.5rem 1.5rem; margin: 0; padding: 0; list-style: none; }
    & .live-usage-row { min-width: 0; padding: 0.6rem 0; border-bottom: 1px dashed var(--live-line); }
    & .live-usage-row header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.6rem; }
    & .live-usage-row strong { color: var(--live-accent); font-size: 0.85rem; font-weight: 500; overflow-wrap: anywhere; }
    & .live-usage-row p { margin: 0.25rem 0; color: var(--live-ink); font-size: 0.8125rem; overflow-wrap: anywhere; }
    & .live-usage-row > small, & .live-usage-row header small, & .live-usage-total small { color: var(--live-muted); font-size: 0.75rem; }
    & .live-usage-row[data-stale="true"] p { color: var(--live-muted); }
    & .live-usage-stale { color: var(--live-amber); font-size: 0.75rem; }
    & .live-usage-stale::before { content: "["; }
    & .live-usage-stale::after { content: "]"; }
    & .live-usage-none { color: var(--live-muted); font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; }
    & .live-usage-total { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.75rem; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--live-accent); font-size: 0.8125rem; }
    & .live-usage-total strong { color: var(--live-accent); font-size: 0.85rem; font-weight: 700; }
    & .live-usage-total span { color: var(--live-ink); overflow-wrap: anywhere; }
    & .live-panel { min-width: 0; border: 1px dashed var(--live-line); background: var(--live-soft); }
    & .live-panel:first-child { border: 2px solid var(--live-accent); }
    & .live-panel > header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 1rem 1.25rem; border-bottom: 1px dashed var(--live-line); }
    & .live-panel h2 { margin: 0; color: var(--live-heading); font-size: 0.95rem; font-weight: 700; }
    & .live-marker { color: var(--live-accent); }
    & .live-panel > header > span { color: var(--live-muted); font-size: 0.75rem; }
    & .live-panel-body { padding: 1.25rem; }
    & .live-empty { margin: 0; padding: 1rem 0; color: var(--live-muted); font-size: 0.85rem; }
    & .live-board-entries { display: grid; grid-template-columns: minmax(0, 1fr); }
    & .live-board-card { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 2.5fr); gap: 0.5rem 1.5rem; min-width: 0; padding: 1rem 0; border-top: 1px dashed var(--live-line); background: transparent; }
    & .live-board-card > header { display: flex; flex-wrap: wrap; align-content: start; align-items: baseline; gap: 0.5rem; }
    & .live-board-card h3 { margin: 0; color: var(--live-accent); font-size: 0.85rem; font-weight: 500; overflow-wrap: anywhere; }
    & .live-board-card h3::before { content: none; }
    & .live-version, .live-board-card small { color: var(--live-muted); font-size: 0.75rem; }
    & .live-board-card small { grid-column: 2; }
    & .live-board-card .board-value { color: var(--live-ink); font-size: 0.85rem; }
    & .kanban-board { gap: 0; margin: 0; padding-bottom: 1rem; }
    & .kanban-column { min-width: 0; padding: 0 0.75rem; border-left: 1px dashed var(--live-line); background: transparent; }
    & .kanban-column:first-child { padding-left: 0; border-left: 0; }
    & .kanban-column-title { opacity: 1; color: var(--live-muted); font-size: 0.75rem; font-weight: 500; }
    & .kanban-column-title::before { content: none; }
    & .kanban-card { padding: 0.4rem 0; border: 0; background: transparent; color: var(--live-ink); overflow-wrap: anywhere; }
    & .kanban-card-title { font-size: 0.85rem; font-weight: 500; }
    & .kanban-card-owner { opacity: 1; color: var(--live-muted); font-size: 0.75rem; }
    & .live-people { display: grid; gap: 0; }
    & .live-person { padding: 0.75rem 0; border-bottom: 1px dashed var(--live-line); }
    & .live-person:first-child { padding-top: 0; }
    & .live-person:last-child { padding-bottom: 0; border-bottom: 0; }
    & .live-person header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; }
    & .live-person strong { color: var(--live-accent); font-size: 0.85rem; font-weight: 500; overflow-wrap: anywhere; }
    & .live-person p { margin: 0.25rem 0; color: var(--live-ink); font-size: 0.8125rem; overflow-wrap: anywhere; }
    & .live-person small { color: var(--live-muted); font-size: 0.75rem; }
    & .live-state { color: var(--live-muted); font-size: 0.75rem; }
    & .live-state::before { content: "["; }
    & .live-state::after { content: "]"; }
    & .live-state[data-state="free"] { color: var(--live-success); }
    & .live-state[data-state="busy"] { color: var(--live-amber); }
    & .message-entry { padding: 1rem 1.25rem; border: 0; border-bottom: 1px dashed var(--live-line); }
    & .message-entry:last-child { border-bottom: 0; }
    & .message-entry summary { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 2.5fr); gap: 0.35rem 1.5rem; align-items: baseline; }
    & .message-from { color: var(--live-accent); font-size: 0.8125rem; font-weight: 500; }
    & .message-time { display: block; opacity: 1; color: var(--live-muted); font-size: 0.75rem; }
    & .message-body { grid-column: 2; grid-row: 1 / span 2; margin: 0; font-size: 0.85rem; }
    & .message-route { grid-column: 1; grid-row: 2; margin: 0; color: var(--live-muted); font-size: 0.75rem; overflow-wrap: anywhere; }
    & .message-technical { margin: 0.75rem 0 0; padding: 0.75rem 0; border-top: 1px dashed var(--live-line); background: transparent; color: var(--live-muted); opacity: 1; font-size: 0.75rem; }
    & .live-activity { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
    & .live-activity > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.75rem; }
    & .live-activity span { color: var(--live-ink); font-size: 0.8125rem; overflow-wrap: anywhere; }
    & .live-activity time { color: var(--live-muted); font-size: 0.75rem; }
    & .live-privacy { margin: 2rem 0 0; padding-top: 1rem; border-top: 1px dashed var(--live-line); color: var(--live-muted); font-size: 0.75rem; }
    @media (max-width: 900px) { & .live-grid { grid-template-columns: minmax(0, 1fr); } & .live-connection { justify-items: start; } }
    @media (max-width: 600px) {
      & .live-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
      & .live-usage-list { grid-template-columns: minmax(0, 1fr); }
      & .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 0; }
      & .kanban-column:nth-child(odd) { padding-left: 0; border-left: 0; }
      & .live-board-card { grid-template-columns: minmax(0, 1fr); gap: 0.5rem; }
      & .live-board-card small { grid-column: 1; }
      & .message-entry summary { display: block; }
      & .message-route { display: block; margin: 0.25rem 0 0.5rem; }
    }
  }
`;
