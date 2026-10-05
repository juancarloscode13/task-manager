(function (global) {
  'use strict';

  const state = global.Taskboard.state;
  const storage = global.Taskboard.storage;
  const taskActions = global.Taskboard.tasks;
  const ui = global.Taskboard.ui;
  const runtime = {
    screen: 'BOARD_SELECTION',
    ready: false,
    loading: true,
    serverAvailable: false
  };
  let lastSavePromise = Promise.resolve(true);
  let hadWriteError = false;

  function render(fileSnapshot) {
    ui.setScreen(runtime.screen);
    if (runtime.screen === 'BOARD_SELECTION') {
      ui.renderBoardSelection(fileSnapshot || state.getFile(), {
        loading: runtime.loading,
        ready: runtime.ready,
        serverAvailable: runtime.serverAvailable
      });
    } else if (runtime.screen === 'BOARD') {
      ui.renderBoard(state.getActiveBoard(), { ready: runtime.ready });
    }
    ui.setConnection({ screen: runtime.screen, ready: runtime.ready });
  }

  function queueSave(fileData) {
    lastSavePromise = storage.save(fileData).then(function () {
      runtime.serverAvailable = true;
      if (hadWriteError) {
        hadWriteError = false;
        ui.clearError();
      }
      return true;
    }).catch(function (error) {
      runtime.serverAvailable = !error.isConnectionError && Number.isInteger(error.status);
      ui.showError(storage.describeError(error), true, 'Reintentar guardado');
      return false;
    });
    return lastSavePromise;
  }

  state.subscribe(function (fileData, reason, shouldPersist) {
    render(fileData);
    if (shouldPersist && runtime.ready) queueSave(fileData);
  });

  storage.onStatus(function (status, label) {
    ui.setSaveStatus(status, label);
    if (status === 'error') hadWriteError = true;
  });

  async function loadFromServer() {
    runtime.loading = true;
    ui.setSaveStatus('saving', 'Conectando...');
    ui.clearError();
    render();
    try {
      const fileData = await storage.load();
      runtime.ready = true;
      runtime.serverAvailable = true;
      runtime.loading = false;
      runtime.screen = 'BOARD_SELECTION';
      state.replaceFile(fileData, 'server-loaded', false);
      ui.setSaveStatus('saved', 'Sincronizado');
      ui.clearError();
      return true;
    } catch (error) {
      runtime.ready = false;
      runtime.serverAvailable = false;
      runtime.loading = false;
      runtime.screen = 'BOARD_SELECTION';
      render();
      ui.setSaveStatus('error', 'Servidor no disponible');
      ui.showError('No se pudo conectar con el servidor local. Comprueba que Taskboard se esté ejecutando y vuelve a intentarlo.', true, 'Reintentar conexión');
      return false;
    }
  }

  async function retry() {
    if (!runtime.ready) return loadFromServer();
    const saved = await storage.save(state.getFile()).then(function () {
      runtime.serverAvailable = true;
      hadWriteError = false;
      ui.clearError();
      return true;
    }).catch(function (error) {
      runtime.serverAvailable = !error.isConnectionError && Number.isInteger(error.status);
      ui.showError(storage.describeError(error), true, 'Reintentar guardado');
      return false;
    });
    return saved;
  }

  function openBoard(boardId) {
    if (!runtime.ready) throw new Error('No se ha podido cargar data.json desde el servidor local.');
    runtime.screen = 'BOARD';
    state.selectBoard(boardId);
    render();
  }

  function backToBoards() {
    runtime.screen = 'BOARD_SELECTION';
    state.selectBoard(null);
    render();
  }

  async function createBoard(title) {
    if (!runtime.ready) throw new Error('El servidor local todavía no está disponible.');
    const name = String(title || '').trim();
    if (!name || name.length > 80) throw new Error('El nombre del tablero debe tener entre 1 y 80 caracteres.');
    runtime.screen = 'BOARD';
    state.createBoard(name, true);
    return lastSavePromise;
  }

  function deleteBoard(boardId) {
    if (!runtime.ready) throw new Error('El servidor local todavía no está disponible.');
    state.deleteBoard(boardId);
    return lastSavePromise;
  }

  function createTask(data) { return taskActions.create(data); }
  function editTask(taskId, data) { taskActions.edit(taskId, data); }
  function deleteTask(taskId) { taskActions.remove(taskId); }
  function changePriority(taskId, priority) { taskActions.setPriority(taskId, priority); }
  function moveTask(taskId, columnId, beforeTaskId) { taskActions.move(taskId, columnId, beforeTaskId); }

  function reorder(taskId, direction) {
    const board = state.getActiveBoard();
    if (!board) return;
    const task = board.tasks.find(function (item) { return item.id === taskId; });
    if (!task) return;
    const columnTasks = board.tasks.filter(function (item) { return item.columnId === task.columnId; }).sort(function (a, b) { return a.order - b.order; });
    const index = columnTasks.findIndex(function (item) { return item.id === taskId; });
    const destination = index + direction;
    if (destination < 0 || destination >= columnTasks.length) return;
    const beforeTask = direction < 0 ? columnTasks[destination] : columnTasks[destination + 1];
    taskActions.move(taskId, task.columnId, beforeTask ? beforeTask.id : null);
  }

  function saveSettings(settings) { taskActions.updateBoardSettings(settings); }

  async function importFile(file) {
    if (!runtime.ready) throw new Error('El servidor local todavía no está disponible para importar.');
    const imported = await storage.readImportFile(file);
    if (!global.confirm('La importación reemplazará todos los tableros y tareas de data.json. ¿Continuar?')) return;
    runtime.screen = 'BOARD_SELECTION';
    state.replaceFile(imported, 'json-imported', true);
    const saved = await lastSavePromise;
    if (saved) ui.clearError();
  }

  function exportFile() {
    let contents;
    try { contents = storage.exportText(state.getFile()); }
    catch (error) { ui.showError(storage.describeError(error), false); return; }
    const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'data.json';
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function initialize() {
    ui.bind({
      retry: retry,
      getFile: state.getFile,
      getBoard: state.getActiveBoard,
      openBoard: openBoard,
      backToBoards: backToBoards,
      createBoard: createBoard,
      deleteBoard: deleteBoard,
      createTask: createTask,
      editTask: editTask,
      deleteTask: deleteTask,
      changePriority: changePriority,
      moveTask: moveTask,
      reorder: reorder,
      saveSettings: saveSettings,
      importFile: importFile,
      export: exportFile
    });
    global.Taskboard.dragdrop.attach({ isReady: function () { return runtime.ready && runtime.screen === 'BOARD'; }, onMove: moveTask });
    render();
    await loadFromServer();
  }

  initialize();
}(window));
