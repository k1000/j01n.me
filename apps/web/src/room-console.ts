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
  .room-console-page .message-technical { max-height: 16rem; overflow: auto; }
  @media (max-width: 760px) { .room-console-page .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 480px) { .room-console-page .kanban-board, .room-console-page .task-editor, .room-console-page .room-meta { grid-template-columns: minmax(0, 1fr); } .room-console-page .room-meta dt { margin-top: 0.5rem; } }
`;

export const ROOM_CONSOLE_SCRIPT = String.raw`
  let taskSaving = false;
  let messageSending = false;
  let boardSaving = false;
  let unknownDelivery;

  function resetMessageDraft() {
    const form = root.querySelector('[data-message-form]');
    if (form) { form.reset(); form.elements.reply_to.value = ''; }
  }

  function updateDeliveryControls() {
    const form = root?.querySelector('[data-message-form]');
    if (!form) return;
    for (const control of form.elements) control.disabled = messageSending || Boolean(unknownDelivery);
    const check = form.querySelector('[data-check-delivery]');
    const retry = form.querySelector('[data-retry-delivery]');
    check.hidden = !unknownDelivery; check.disabled = messageSending;
    retry.hidden = !unknownDelivery?.checked; retry.disabled = messageSending;
    if (unknownDelivery) form.querySelector('[data-message-status]').textContent = unknownDelivery.checked
      ? 'Delivery unknown after refresh. Check again; retrying may duplicate the message.'
      : 'Delivery unknown. Check delivery before resending.';
  }

  function updateReplyStatus() {
    const form = root?.querySelector('[data-message-form]');
    if (!form) return;
    const id = form.elements.reply_to.value;
    const message = latest?.messages.find(m => m.id === id);
    form.querySelector('[data-reply-status]').textContent = id ? 'Replying to ' + (message?.from || id) : '';
    form.querySelector('[data-cancel-reply]').hidden = !id;
  }

  function wireMessageComposer() {
    const form = root?.querySelector('[data-message-form]');
    if (!form) return;
    updateDeliveryControls();
    form.querySelector('[data-check-delivery]').addEventListener('click', async () => {
      if (messageSending || !unknownDelivery) return;
      const pending = unknownDelivery;
      messageSending = true; updateDeliveryControls();
      try {
        await refreshRoom();
        let delivered;
        for (const message of latest.messages) {
          if (message.from !== participantId) continue;
          const decoded = await decryptMessageBody(message, latest.messages);
          if (decoded.ok && decoded.value?.client_message_id === pending.id) { delivered = message; break; }
        }
        if (delivered) {
          unknownDelivery = undefined; resetMessageDraft();
          root.querySelector('[data-message-status]').textContent = 'Delivered as message #' + delivered.seq + '. Do not resend.';
        } else pending.checked = true;
      } catch (error) { showRoomEventError(error); }
      finally { messageSending = false; updateDeliveryControls(); updateReplyStatus(); }
    });
    form.querySelector('[data-retry-delivery]').addEventListener('click', () => {
      if (messageSending || !unknownDelivery?.checked) return;
      if (!window.confirm('Delivery is still unknown. Resending may duplicate a committed message or question. Allow a manual retry?')) return;
      unknownDelivery = undefined; updateDeliveryControls();
      root.querySelector('[data-message-status]').textContent = 'Manual retry allowed. The previous attempt may still be delivered.';
    });
    root.querySelectorAll('[data-reply-message]').forEach(button => button.addEventListener('click', () => {
      if (messageSending || unknownDelivery) return;
      form.elements.reply_to.value = button.dataset.replyMessage;
      form.elements.to.value = button.dataset.replyRecipient;
      updateReplyStatus();
      form.elements.message.focus();
    }));
    form.querySelector('[data-cancel-reply]').addEventListener('click', () => { form.elements.reply_to.value = ''; updateReplyStatus(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (messageSending || unknownDelivery) return;
      const data = new FormData(form);
      const text = String(data.get('message') || '').trim();
      const to = String(data.get('to') || '');
      const status = form.querySelector('[data-message-status]');
      if (!text) { status.textContent = 'Message is required.'; return; }
      if (!to) { status.textContent = 'Choose an active recipient before sending.'; return; }
      messageSending = true;
      for (const control of form.elements) control.disabled = true;
      status.textContent = 'Encrypting…';
      let sent = false;
      try {
        const result = await sendText(to, text, { replyTo: data.get('reply_to') || null, expectsReply: data.has('expects_reply') });
        sent = true;
        resetMessageDraft();
        await refreshRoom();
        root.querySelector('[data-message-status]').textContent = 'Sent message #' + result.seq + '.';
      } catch (error) {
        const currentStatus = root.querySelector('[data-message-status]');
        if (currentStatus) currentStatus.textContent = sent ? 'Message sent; room refresh failed. Use Retry to catch up, not Send.' : error.message;
        if (sent) showRoomEventError(error);
      } finally { messageSending = false; updateDeliveryControls(); updateReplyStatus(); }
    });
  }

  function renderTaskEditor(board, participants) {
    const owners = '<option value="">Unassigned</option>' + Object.values(participants).filter(p => !p.left_at).map(p => '<option value="' + escAttr(p.id) + '">' + esc(p.id) + '</option>').join('');
    return '<form class="task-editor" data-kanban-add-task>' +
      '<input type="hidden" name="task_id" /><input type="hidden" name="tasks_version" value="' + (board.tasks?.version || 0) + '" /><input type="hidden" name="columns_version" value="' + (board.columns?.version || 0) + '" />' +
      '<label class="task-wide">Task title<input name="task_title" required maxlength="240" placeholder="What needs to be done?" /></label>' +
      '<label class="task-wide">Description and acceptance criteria<textarea name="task_description" placeholder="Context, expected result and how to verify it"></textarea></label>' +
      '<label>Owner<select name="task_owner">' + owners + '</select></label>' +
      '<label>Column<select name="task_column"><option value="todo">To Do</option><option value="doing">Doing</option><option value="review">Review</option><option value="done">Done</option></select></label>' +
      '<label>Priority<select name="task_priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>' +
      '<div class="task-wide"><button class="button" type="submit">Save task</button> <button class="button" type="button" data-task-cancel>Clear editor</button></div><p class="task-wide" data-task-status role="status"></p></form>';
  }

  function restoreTaskOwner(select, value) {
    if (value && ![...select.options].some(option => option.value === value)) select.add(new Option(value + ' (not active)', value));
    select.value = value;
  }

  function wireTaskEditor(board) {
    const form = root?.querySelector('[data-kanban-add-task]');
    if (!form) return;
    for (const control of form.elements) control.disabled = taskSaving;
    const tasks = extractValue(board.tasks?.value) || {};
    const columns = extractValue(board.columns?.value) || {};
    root.querySelectorAll('[data-edit-task]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.editTask;
      const task = tasks[id];
      form.elements.task_id.value = id;
      form.elements.task_title.value = typeof task === 'object' ? task.title || id : String(task || id);
      form.elements.task_description.value = task?.description || '';
      restoreTaskOwner(form.elements.task_owner, task?.owner || '');
      form.elements.task_priority.value = task?.priority || 'normal';
      form.elements.task_column.value = Object.keys(columns).find(c => Array.isArray(columns[c]) && columns[c].includes(id)) || 'todo';
      form.elements.tasks_version.value = board.tasks?.version || 0;
      form.elements.columns_version.value = board.columns?.version || 0;
      form.querySelector('[data-task-status]').textContent = 'Editing ' + id;
      form.elements.task_title.focus();
    }));
    form.querySelector('[data-task-cancel]').addEventListener('click', () => { form.reset(); form.elements.task_id.value = ''; form.querySelector('[data-task-status]').textContent = ''; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (taskSaving) return;
      const values = new FormData(form);
      const title = String(values.get('task_title') || '').trim();
      if (!title) return;
      const id = String(values.get('task_id') || '') || 'task-' + crypto.randomUUID();
      const column = String(values.get('task_column') || 'todo');
      const versions = { tasks: Number(values.get('tasks_version')), columns: Number(values.get('columns_version')) };
      form.elements.task_id.value = id;
      taskSaving = true;
      for (const control of form.elements) control.disabled = true;
      form.querySelector('[data-task-status]').textContent = 'Saving…';
      let saved = false;
      try {
        const read = await fetch('/r/' + encodeURIComponent(rid) + '/board', { headers: authHeaders() });
        const snapshot = await read.json();
        if (!read.ok) throw new Error(snapshot.error || 'Could not read board.');
        const currentTasks = extractValue(snapshot.board.tasks?.value) || {};
        const currentColumns = extractValue(snapshot.board.columns?.value) || {};
        const columns = { ...currentColumns };
        for (const c of ['todo', 'doing', 'review', 'done']) columns[c] = Array.isArray(columns[c]) ? columns[c].filter(taskId => taskId !== id) : [];
        columns[column].push(id);
        const tasks = { ...currentTasks, [id]: { ...(typeof currentTasks[id] === 'object' ? currentTasks[id] : {}), title,
          description: String(values.get('task_description') || '').trim(), owner: values.get('task_owner') || null, state: column,
          priority: values.get('task_priority') || 'normal' } };
        const response = await fetch('/r/' + encodeURIComponent(rid) + '/board?if_versions=' + encodeURIComponent(JSON.stringify(versions)), {
          method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ tasks: wrapBoardValue(tasks), columns: wrapBoardValue(columns) }),
        });
        const result = await response.json();
        if (!response.ok) {
          if (response.status === 409) {
            await refreshRoom();
            const currentForm = root.querySelector('[data-kanban-add-task]');
            currentForm.elements.tasks_version.value = latest.board.tasks?.version || 0;
            currentForm.elements.columns_version.value = latest.board.columns?.version || 0;
            throw new Error('Board changed while you were editing. Your draft is kept. Review the board, then retry.');
          }
          throw new Error(result.error || 'Could not save task.');
        }
        saved = true;
        const currentForm = root.querySelector('[data-kanban-add-task]');
        if (currentForm) { currentForm.reset(); currentForm.elements.task_id.value = ''; }
        await refreshRoom();
        root.querySelector('[data-task-status]').textContent = 'Task saved.';
      } catch (error) { const status = root.querySelector('[data-task-status]'); if (status) status.textContent = saved ? 'Task saved; room refresh failed. Use Retry, not Save.' : error.message; if (saved) showRoomEventError(error); }
      finally { taskSaving = false; for (const control of root.querySelector('[data-kanban-add-task]')?.elements || []) control.disabled = false; }
    });
  }

  function captureConsoleDrafts() {
    const forms = ['data-message-form', 'data-kanban-add-task', 'data-board-form'];
    return forms.map(attribute => {
      const form = root?.querySelector('[' + attribute + ']');
      if (!form) return null;
      const values = [...form.elements].filter(c => c.name).map(c => ({ name: c.name, value: c.value, checked: c.checked }));
      const focus = document.activeElement?.form === form ? { index: [...form.elements].indexOf(document.activeElement), start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
      return { attribute, values, focus, visible: form.classList.contains('is-visible') };
    }).filter(Boolean);
  }

  function restoreConsoleDrafts(drafts) {
    for (const draft of drafts) {
      const form = root.querySelector('[' + draft.attribute + ']');
      if (!form) continue;
      const dirtyTask = draft.values.some(v => ['task_id', 'task_title', 'task_description'].includes(v.name) && v.value);
      for (const value of draft.values) {
        const control = form.elements.namedItem(value.name);
        if (!control || (!dirtyTask && value.name.endsWith('_version'))) continue;
        if (value.name === 'task_owner') restoreTaskOwner(control, value.value); else control.value = value.value;
        if (typeof value.checked === 'boolean') control.checked = value.checked;
      }
      form.classList.toggle('is-visible', draft.visible);
      if (draft.attribute === 'data-board-form') form.elements.key.readOnly = Boolean(form.elements.original_key.value);
      if (draft.focus) {
        const control = form.elements[draft.focus.index];
        if (control) { control.focus({ preventScroll: true }); if (typeof draft.focus.start === 'number') control.setSelectionRange(draft.focus.start, draft.focus.end); }
      }
    }
  }
`;
