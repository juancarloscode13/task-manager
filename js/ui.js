(function (global) {
  'use strict';

  const labels = { low: 'Baja', medium: 'Media', high: 'Alta', urgent: 'Urgente' };
  const themeKey = 'taskboard-theme';
  const $ = function (selector, root) { return (root || document).querySelector(selector); };
  const boardElement = $('#board');
  const statusElement = $('#save-status');
  const themeSelect = $('#theme-select');
  let themePreference = 'system';
  let colorSchemeQuery = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, attributes) {
    const node = element('button', className, text);
    node.type = 'button';
    Object.entries(attributes || {}).forEach(function (entry) { node.setAttribute(entry[0], entry[1]); });
    return node;
  }

  function addOption(select, value, text) {
    const option = element('option', '', text);
    option.value = value;
    select.append(option);
  }

  function setSaveStatus(state, label) {
    statusElement.dataset.state = state;
    $('.status-label', statusElement).textContent = label;
  }

  function showError(message, canRetry, retryLabel) {
    $('#error-message').textContent = message;
    $('#error-banner').hidden = false;
    $('#retry-button').hidden = !canRetry;
    $('#retry-button').textContent = retryLabel || 'Volver a intentar';
  }

  function clearError() {
    $('#error-banner').hidden = true;
    $('#error-message').textContent = '';
    $('#retry-button').hidden = true;
    $('#retry-button').textContent = 'Volver a intentar';
  }

  function setScreen(screen) {
    $('#file-selection').hidden = screen !== 'FILE_SELECTION';
    $('#board-selection').hidden = screen !== 'BOARD_SELECTION';
    $('#board-screen').hidden = screen !== 'BOARD';
    $('#back-to-boards-button').hidden = screen !== 'BOARD';
    $('#settings-button').hidden = screen !== 'BOARD';
    if (screen !== 'BOARD') document.title = 'Taskboard';
  }

  function renderFileSelection(options) {
    const notice = $('#file-api-notice');
    notice.hidden = Boolean(options.available);
    $('#open-file-button').disabled = !options.available || Boolean(options.loading);
    $('#create-file-button').disabled = !options.available || Boolean(options.loading);
    if (!options.available) {
      if (options.secureContext === false) {
        $('#file-api-title').textContent = 'Abre la aplicación en un contexto seguro';
        $('#file-api-copy').textContent = 'El selector de archivos requiere HTTPS o localhost. En un contexto seguro, este navegador también debe ofrecer File System Access API.';
      } else {
        $('#file-api-title').textContent = 'Este navegador no permite acceso directo a archivos';
        $('#file-api-copy').textContent = 'No es un problema de permisos. Zen/Firefox no implementa los selectores de la File System Access API que permiten guardar data.json automáticamente. Abre la aplicación en Chrome o Edge para usar el guardado directo.';
      }
    }
    setSaveStatus(options.available ? 'idle' : 'error', options.loading ? 'Cargando archivo…' : (options.available ? 'Selecciona un archivo' : 'API no disponible'));
  }

  function renderBoardSelection(fileData, options) {
    const cards = $('#board-cards');
    const boards = fileData.boards;
    $('#selected-file-name').textContent = options.fileName || 'data.json';
    $('#board-selection-subtitle').textContent = boards.length
      ? boards.length + (boards.length === 1 ? ' tablero en este archivo.' : ' tableros en este archivo.')
      : 'Este archivo todavía no tiene tableros. Crea uno para empezar.';
    $('#create-board-button').disabled = !options.ready;
    $('#change-file-button').disabled = !options.available || Boolean(options.loading);
    $('#import-button').disabled = !options.ready;
    $('#export-button').disabled = false;
    cards.replaceChildren();
    if (boards.length === 0) {
      cards.append(element('div', 'empty-boards', 'Todavía no hay tableros. Crea uno con las columnas iniciales.'));
      return;
    }
    const fragment = document.createDocumentFragment();
    boards.forEach(function (board) {
      const card = element('article', 'board-card');
      const content = element('div', 'board-card-content');
      content.append(element('h2', 'board-card-title', board.settings.boardTitle));
      content.append(element('p', 'board-card-meta', board.tasks.length + (board.tasks.length === 1 ? ' tarea' : ' tareas')));
      card.append(content);
      const actions = element('div', 'board-card-actions');
      actions.append(button('button button-primary', 'Abrir', { 'data-board-open': board.id }));
      const deleteButton = button('button button-quiet board-delete-button', 'Eliminar', { 'data-board-delete': board.id });
      deleteButton.disabled = !options.ready;
      actions.append(deleteButton);
      card.append(actions);
      fragment.append(card);
    });
    cards.append(fragment);
  }

  function setConnection(options) {
    const notice = $('#connection-notice');
    const show = options.screen === 'BOARD' && !options.ready && Boolean(options.connected);
    notice.hidden = !show;
    $('#add-task-button').disabled = !options.ready;
    $('#settings-button').disabled = !options.ready;
    if (show) {
      $('#connection-title').textContent = options.needsPermission ? 'Hace falta permiso para guardar' : 'El tablero está en modo de solo lectura';
      $('.notice-copy p', notice).textContent = options.needsPermission
        ? 'Concede acceso de escritura para guardar automáticamente los cambios en data.json.'
        : 'Conecta de nuevo data.json para modificar y guardar este tablero.';
      $('[data-action="connect"]', notice).textContent = options.needsPermission ? 'Conceder acceso' : 'Conectar archivo';
    }
  }

  function dateLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(date);
  }

  function renderTask(task, columns, ready, position, total) {
    const card = element('article', 'task-card');
    card.dataset.taskId = task.id;
    card.draggable = ready;
    card.tabIndex = 0;
    card.setAttribute('role', 'listitem');
    const titleRow = element('div', 'task-title-row');
    titleRow.append(element('h3', '', task.title));
    const actions = element('div', 'task-actions');
    const reorderUp = button('task-action reorder-action', '↑', { 'data-task-action': 'reorder-up', 'data-task-id': task.id, 'aria-label': 'Subir ' + task.title, title: 'Subir tarea' });
    reorderUp.disabled = !ready || position === 0;
    const reorderDown = button('task-action reorder-action', '↓', { 'data-task-action': 'reorder-down', 'data-task-id': task.id, 'aria-label': 'Bajar ' + task.title, title: 'Bajar tarea' });
    reorderDown.disabled = !ready || position === total - 1;
    actions.append(reorderUp, reorderDown);
    const editButton = button('task-action', 'Editar', { 'data-task-action': 'edit', 'data-task-id': task.id, 'aria-label': 'Editar: ' + task.title });
    editButton.disabled = !ready;
    const deleteButton = button('task-action task-delete-action', '×', { 'data-task-action': 'delete', 'data-task-id': task.id, 'aria-label': 'Eliminar: ' + task.title, title: 'Eliminar tarea' });
    deleteButton.disabled = !ready;
    actions.append(editButton, deleteButton);
    titleRow.append(actions);
    card.append(titleRow);
    if (task.description) card.append(element('p', 'task-description', task.description));
    card.append(element('span', 'priority-pill priority-' + task.priority, labels[task.priority] || 'Media'));
    const meta = element('div', 'task-meta');
    meta.append(element('span', 'task-date', dateLabel(task.createdAt)));
    const controls = element('div', 'task-controls');
    const priority = element('select', 'task-control priority-control');
    priority.setAttribute('aria-label', 'Prioridad de ' + task.title);
    priority.dataset.taskAction = 'priority';
    priority.dataset.taskId = task.id;
    Object.entries(labels).forEach(function (entry) { addOption(priority, entry[0], entry[1]); });
    priority.value = task.priority;
    priority.disabled = !ready;
    controls.append(priority);
    const move = element('select', 'task-control move-control');
    move.setAttribute('aria-label', 'Mover ' + task.title + ' a una columna');
    move.dataset.taskAction = 'move';
    move.dataset.taskId = task.id;
    columns.forEach(function (column) { addOption(move, column.id, column.name); });
    move.value = task.columnId;
    move.disabled = !ready;
    controls.append(move);
    meta.append(controls);
    card.append(meta);
    return card;
  }

  function renderBoard(board, options) {
    if (!board) return;
    const ready = Boolean(options && options.ready);
    $('#board-title').textContent = board.settings.boardTitle;
    document.title = 'Taskboard · ' + board.settings.boardTitle;
    $('#board-subtitle').textContent = board.tasks.length
      ? board.tasks.length + (board.tasks.length === 1 ? ' tarea en este tablero' : ' tareas en este tablero')
      : 'Organiza el trabajo, paso a paso.';
    boardElement.setAttribute('aria-label', 'Tablero de tareas: ' + board.settings.boardTitle);
    boardElement.replaceChildren();
    const fragment = document.createDocumentFragment();
    board.columns.forEach(function (column) {
      const tasks = board.tasks.filter(function (task) { return task.columnId === column.id; }).sort(function (a, b) { return a.order - b.order; });
      const section = element('section', 'column');
      section.dataset.columnId = column.id;
      const header = element('header', 'column-header');
      header.append(element('span', 'column-marker'));
      header.append(element('h2', 'column-title', column.name));
      const count = element('span', 'task-count', String(tasks.length));
      count.setAttribute('aria-label', tasks.length + (tasks.length === 1 ? ' tarea' : ' tareas'));
      header.append(count);
      const addButton = button('column-add', '+', { 'data-add-to': column.id, 'aria-label': 'Añadir tarea a ' + column.name, title: 'Añadir tarea' });
      addButton.disabled = !ready;
      header.append(addButton);
      section.append(header);
      const list = element('div', 'task-list');
      list.setAttribute('role', 'list');
      list.dataset.columnId = column.id;
      tasks.forEach(function (task, index) { list.append(renderTask(task, board.columns, ready, index, tasks.length)); });
      const emptyMessage = ready ? 'Suelta aquí una tarea o crea una nueva' : 'Concede acceso para modificar este tablero';
      const empty = element('div', 'empty-column', emptyMessage);
      empty.setAttribute('role', 'presentation');
      empty.hidden = tasks.length > 0;
      list.append(empty);
      section.append(list);
      fragment.append(section);
    });
    boardElement.append(fragment);
  }

  function openTaskDialog(board, task, columnId) {
    const dialog = $('#task-dialog');
    const editing = Boolean(task);
    $('#task-dialog-title').textContent = editing ? 'Editar tarea' : 'Nueva tarea';
    $('#submit-task-button').textContent = editing ? 'Guardar tarea' : 'Crear tarea';
    $('#delete-task-button').hidden = !editing;
    $('#task-id').value = editing ? task.id : '';
    $('#task-title').value = editing ? task.title : '';
    $('#task-description').value = editing ? task.description : '';
    $('#task-priority').value = editing ? task.priority : 'medium';
    const columnSelect = $('#task-column');
    columnSelect.replaceChildren();
    board.columns.forEach(function (column) { addOption(columnSelect, column.id, column.name); });
    columnSelect.value = editing ? task.columnId : (columnId || board.columns[0].id);
    $('#form-error').hidden = true;
    if (!dialog.open) dialog.showModal();
    $('#task-title').focus();
  }

  function openSettingsDialog(board) {
    $('#board-name').value = board.settings.boardTitle;
    const fields = $('#column-fields');
    fields.replaceChildren();
    const template = $('#column-field-template');
    board.columns.forEach(function (column, index) {
      const row = template.content.firstElementChild.cloneNode(true);
      const label = $('.field-label', row);
      const input = $('input', row);
      label.htmlFor = 'column-name-' + index;
      label.textContent = 'Columna ' + (index + 1);
      input.id = 'column-name-' + index;
      input.name = 'columnName';
      input.value = column.name;
      input.dataset.columnId = column.id;
      fields.append(row);
    });
    $('#settings-error').hidden = true;
    $('#settings-dialog').showModal();
    $('#board-name').focus();
  }

  function openNewBoardDialog() {
    $('#new-board-name').value = '';
    $('#new-board-error').hidden = true;
    $('#new-board-dialog').showModal();
    $('#new-board-name').focus();
  }

  function focusControl(taskId, action) {
    const control = Array.from(boardElement.querySelectorAll('[data-task-id][data-task-action]')).find(function (node) {
      return node.dataset.taskId === taskId && node.dataset.taskAction === action;
    });
    if (control) control.focus();
  }

  function safely(action) {
    try {
      const result = action();
      if (result && typeof result.then === 'function') result.catch(function (error) { showError(error.message || String(error), false); });
    } catch (error) { showError(error.message || String(error), false); }
  }

  function applyTheme() {
    const resolved = themePreference === 'system'
      ? (colorSchemeQuery && colorSchemeQuery.matches ? 'dark' : 'light')
      : themePreference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = themePreference;
    const themeColor = $('meta[name="theme-color"]');
    if (themeColor) themeColor.content = resolved === 'dark' ? '#171a24' : '#f6f7fa';
    themeSelect.value = themePreference;
  }

  function initializeTheme() {
    try {
      const stored = global.localStorage.getItem(themeKey);
      if (stored === 'light' || stored === 'dark' || stored === 'system') themePreference = stored;
    } catch (error) { /* el tema sigue funcionando durante esta sesión */ }
    if (typeof global.matchMedia === 'function') {
      colorSchemeQuery = global.matchMedia('(prefers-color-scheme: dark)');
      const onSchemeChange = function () { if (themePreference === 'system') applyTheme(); };
      if (typeof colorSchemeQuery.addEventListener === 'function') colorSchemeQuery.addEventListener('change', onSchemeChange);
      else if (typeof colorSchemeQuery.addListener === 'function') colorSchemeQuery.addListener(onSchemeChange);
    }
    applyTheme();
  }

  function setTheme(preference) {
    if (preference !== 'light' && preference !== 'dark' && preference !== 'system') return;
    themePreference = preference;
    try { global.localStorage.setItem(themeKey, preference); }
    catch (error) { showError('No se pudo guardar la preferencia del tema en este navegador.', false); }
    applyTheme();
  }

  function bind(handlers) {
    initializeTheme();
    themeSelect.addEventListener('change', function () { setTheme(themeSelect.value); });
    $('#open-file-button').addEventListener('click', function () { safely(handlers.openFile); });
    $('#create-file-button').addEventListener('click', function () { safely(handlers.createFile); });
    $('#change-file-button').addEventListener('click', function () { safely(handlers.changeFile); });
    $('#create-board-button').addEventListener('click', openNewBoardDialog);
    $('#back-to-boards-button').addEventListener('click', handlers.backToBoards);
    $('[data-action="connect"]').addEventListener('click', function () { safely(handlers.connect); });
    $('#retry-button').addEventListener('click', function () { safely(handlers.retry); });
    $('#dismiss-error').addEventListener('click', clearError);
    $('#settings-button').addEventListener('click', function () { openSettingsDialog(handlers.getBoard()); });
    $('#add-task-button').addEventListener('click', function () { openTaskDialog(handlers.getBoard()); });
    $('#export-button').addEventListener('click', handlers.export);
    $('#import-button').addEventListener('click', function () { $('#import-file').click(); });
    $('#import-file').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      if (file) safely(function () { return handlers.importFile(file); });
      event.target.value = '';
    });

    document.querySelectorAll('[data-close-dialog]').forEach(function (control) {
      control.addEventListener('click', function () { control.closest('dialog').close(); });
    });
    document.querySelectorAll('dialog').forEach(function (dialog) {
      dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
    });

    $('#board-cards').addEventListener('click', function (event) {
      const open = event.target.closest('[data-board-open]');
      if (open) { handlers.openBoard(open.dataset.boardOpen); return; }
      const remove = event.target.closest('[data-board-delete]');
      if (remove) {
        const board = handlers.getFile().boards.find(function (item) { return item.id === remove.dataset.boardDelete; });
        if (board && global.confirm('¿Eliminar el tablero “' + board.settings.boardTitle + '” y todas sus tareas?')) safely(function () { return handlers.deleteBoard(board.id); });
      }
    });

    $('#new-board-form').addEventListener('submit', function (event) {
      event.preventDefault();
      try {
        handlers.createBoard($('#new-board-name').value);
        $('#new-board-dialog').close();
      } catch (error) {
        $('#new-board-error').textContent = error.message || String(error);
        $('#new-board-error').hidden = false;
      }
    });

    $('#board').addEventListener('click', function (event) {
      const add = event.target.closest('[data-add-to]');
      if (add) { openTaskDialog(handlers.getBoard(), null, add.dataset.addTo); return; }
      const action = event.target.closest('[data-task-action="edit"], [data-task-action="delete"], [data-task-action="reorder-up"], [data-task-action="reorder-down"]');
      if (!action) return;
      const taskId = action.dataset.taskId;
      const board = handlers.getBoard();
      const task = board.tasks.find(function (item) { return item.id === taskId; });
      if (!task) return;
      if (action.dataset.taskAction === 'edit') openTaskDialog(board, task);
      if (action.dataset.taskAction === 'delete' && global.confirm('¿Eliminar “' + task.title + '”? Esta acción no se puede deshacer.')) safely(function () { return handlers.deleteTask(taskId); });
      if (action.dataset.taskAction === 'reorder-up' || action.dataset.taskAction === 'reorder-down') {
        safely(function () { return handlers.reorder(taskId, action.dataset.taskAction === 'reorder-up' ? -1 : 1); });
        global.requestAnimationFrame(function () { focusControl(taskId, action.dataset.taskAction); });
      }
    });

    $('#board').addEventListener('change', function (event) {
      const target = event.target.closest('[data-task-action="priority"], [data-task-action="move"]');
      if (!target) return;
      const taskId = target.dataset.taskId;
      const action = target.dataset.taskAction;
      safely(function () {
        return action === 'priority' ? handlers.changePriority(taskId, target.value) : handlers.moveTask(taskId, target.value, null);
      });
      global.requestAnimationFrame(function () { focusControl(taskId, action); });
    });

    $('#task-form').addEventListener('submit', function (event) {
      event.preventDefault();
      const taskId = $('#task-id').value;
      const data = { title: $('#task-title').value, description: $('#task-description').value, priority: $('#task-priority').value, columnId: $('#task-column').value };
      safely(async function () {
        try {
          if (taskId) await handlers.editTask(taskId, data);
          else await handlers.createTask(data);
          $('#task-dialog').close();
          $('#add-task-button').focus();
        } catch (error) {
          $('#form-error').textContent = error.message || String(error);
          $('#form-error').hidden = false;
        }
      });
    });

    $('#delete-task-button').addEventListener('click', function () {
      const taskId = $('#task-id').value;
      const task = handlers.getBoard().tasks.find(function (item) { return item.id === taskId; });
      if (!task || !global.confirm('¿Eliminar “' + task.title + '”? Esta acción no se puede deshacer.')) return;
      safely(async function () {
        await handlers.deleteTask(taskId);
        $('#task-dialog').close();
        $('#add-task-button').focus();
      });
    });

    $('#settings-form').addEventListener('submit', function (event) {
      event.preventDefault();
      const fields = Array.from($('#column-fields').querySelectorAll('input'));
      safely(function () {
        try {
          handlers.saveSettings({ boardTitle: $('#board-name').value, columnNames: fields.map(function (input) { return input.value; }) });
          $('#settings-dialog').close();
        } catch (error) {
          $('#settings-error').textContent = error.message || String(error);
          $('#settings-error').hidden = false;
        }
      });
    });
  }

  global.Taskboard = global.Taskboard || {};
  global.Taskboard.ui = {
    bind: bind,
    setScreen: setScreen,
    renderFileSelection: renderFileSelection,
    renderBoardSelection: renderBoardSelection,
    renderBoard: renderBoard,
    setConnection: setConnection,
    setSaveStatus: setSaveStatus,
    showError: showError,
    clearError: clearError
  };
}(window));
