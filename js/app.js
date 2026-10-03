(function (global) {
  'use strict';

  const state = global.Taskboard.state;
  const storage = global.Taskboard.storage;
  const taskActions = global.Taskboard.tasks;
  const ui = global.Taskboard.ui;
  const runtime = {
    screen: 'FILE_SELECTION',
    fileLoaded: false,
    connected: false,
    needsPermission: false,
    ready: false,
    loading: true,
    available: storage.isAvailable(),
    secureContext: global.isSecureContext !== false,
    fileName: 'data.json'
  };
  let lastSavePromise = Promise.resolve(true);
  let hadWriteError = false;

  function render(fileSnapshot) {
    ui.setScreen(runtime.screen);
    if (runtime.screen === 'FILE_SELECTION') {
      ui.renderFileSelection({ available: runtime.available, loading: runtime.loading, secureContext: runtime.secureContext });
    } else if (runtime.screen === 'BOARD_SELECTION') {
      ui.renderBoardSelection(fileSnapshot || state.getFile(), {
        fileName: runtime.fileName,
        available: runtime.available,
        loading: runtime.loading,
        ready: runtime.ready
      });
    } else if (runtime.screen === 'BOARD') {
      ui.renderBoard(state.getActiveBoard(), { ready: runtime.ready });
    }
    ui.setConnection({
      screen: runtime.screen,
      ready: runtime.ready,
      connected: runtime.connected,
      needsPermission: runtime.needsPermission
    });
  }

  function queueSave(fileData) {
    lastSavePromise = storage.save(fileData).then(function () {
      runtime.connected = true;
      return true;
    }).catch(function (error) {
      ui.showError(storage.describeError(error), true, runtime.ready ? 'Reintentar guardado' : 'Conceder acceso');
      return false;
    });
    return lastSavePromise;
  }

  state.subscribe(function (fileData, reason, shouldPersist) {
    render(fileData);
    if (shouldPersist && runtime.fileLoaded && runtime.ready) queueSave(fileData);
  });

  storage.onStatus(function (status, label) {
    ui.setSaveStatus(status, label);
    if (status === 'error') {
      hadWriteError = true;
      ui.showError('No se pudo escribir data.json. Comprueba el permiso y que el archivo siga en su ubicación.', true, 'Reintentar guardado');
    } else if (status === 'saved' && hadWriteError) {
      hadWriteError = false;
      ui.clearError();
    }
  });

  function showConnectionFailure(error) {
    const message = storage.describeError(error);
    runtime.connected = storage.hasHandle();
    ui.showError(message, true, runtime.ready ? 'Reintentar guardado' : 'Volver a conectar');
    render();
  }

  function finishLoad(result) {
    if (!result || result.kind === 'cancelled') return;
    if (result.kind !== 'loaded' && result.kind !== 'permission') return;
    runtime.fileLoaded = true;
    runtime.connected = true;
    runtime.needsPermission = result.kind === 'permission';
    runtime.ready = result.kind === 'loaded';
    runtime.screen = 'BOARD_SELECTION';
    runtime.fileName = 'data.json';
    state.replaceFile(result.fileData, 'file-loaded', false);
    ui.clearError();
    ui.setSaveStatus(runtime.ready ? 'saved' : 'idle', runtime.ready ? 'Guardado' : 'Permiso pendiente');
    if (result.warning) ui.showError(result.warning, true, runtime.ready ? 'Reintentar guardado' : 'Conceder acceso');
    else if (runtime.needsPermission) ui.showError('Concede permiso para editar y guardar cambios en data.json.', true, 'Conceder acceso');
  }

  async function openFile() {
    ui.clearError();
    try { finishLoad(await storage.selectFile()); }
    catch (error) { showConnectionFailure(error); }
  }

  async function connect() {
    ui.clearError();
    try {
      const result = storage.hasHandle() ? await storage.connectSaved() : await storage.selectFile();
      finishLoad(result);
    } catch (error) { showConnectionFailure(error); }
  }

  async function createFile() {
    ui.clearError();
    try { finishLoad(await storage.createFile(state.createInitialFile())); }
    catch (error) { showConnectionFailure(error); }
  }

  async function changeFile() {
    runtime.screen = 'FILE_SELECTION';
    runtime.fileLoaded = false;
    runtime.connected = false;
    runtime.needsPermission = false;
    runtime.ready = false;
    runtime.loading = false;
    state.replaceFile(state.createInitialFile(), 'file-cleared', false);
    ui.clearError();
    ui.setSaveStatus('idle', 'Selecciona un archivo');
    try { await storage.clearHandle(); }
    catch (error) { ui.showError('No se pudo olvidar el acceso anterior: ' + storage.describeError(error), false); }
    render();
  }

  async function retry() {
    if (!runtime.ready) return connect();
    try {
      await storage.authorizeSaved();
      const saved = await storage.save(state.getFile());
      if (saved !== false) {
        ui.clearError();
        ui.setSaveStatus('saved', 'Guardado');
      }
    } catch (error) {
      ui.showError(storage.describeError(error), true, 'Reintentar guardado');
      ui.setSaveStatus('error', 'Error al guardar');
    }
  }

  function openBoard(boardId) {
    if (!runtime.fileLoaded) throw new Error('Primero selecciona un archivo data.json.');
    runtime.screen = 'BOARD';
    state.selectBoard(boardId);
    render();
  }

  function backToBoards() {
    runtime.screen = 'BOARD_SELECTION';
    state.selectBoard(null);
    render();
  }

  function createBoard(title) {
    if (!runtime.ready) throw new Error('Concede permiso de escritura antes de crear tableros.');
    const name = String(title || '').trim();
    if (!name || name.length > 80) throw new Error('El nombre del tablero debe tener entre 1 y 80 caracteres.');
    runtime.screen = 'BOARD';
    state.createBoard(name, true);
  }

  function deleteBoard(boardId) {
    if (!runtime.ready) throw new Error('Concede permiso de escritura antes de eliminar tableros.');
    state.deleteBoard(boardId);
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
    if (!runtime.ready || !storage.hasHandle()) throw new Error('Conecta data.json con permiso de escritura antes de importar.');
    const imported = await storage.readImportFile(file);
    if (!global.confirm('La importación reemplazará todos los tableros y tareas de data.json. ¿Continuar?')) return;
    runtime.screen = 'BOARD_SELECTION';
    runtime.fileLoaded = true;
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

  function handleInitialResult(result) {
    if (!result) return;
    runtime.loading = false;
    if (result.kind === 'loaded' || result.kind === 'permission') finishLoad(result);
    else if (result.kind === 'unavailable') {
      runtime.available = false;
      runtime.screen = 'FILE_SELECTION';
      ui.setSaveStatus('error', 'API no disponible');
      render();
    } else if (result.kind === 'error') {
      runtime.connected = Boolean(result.connected);
      runtime.screen = 'FILE_SELECTION';
      render();
      ui.showError(storage.describeError(result.error), true, 'Volver a conectar');
    } else {
      runtime.screen = 'FILE_SELECTION';
      runtime.connected = false;
      ui.setSaveStatus('idle', 'Selecciona un archivo');
      render();
    }
  }

  async function initialize() {
    ui.bind({
      openFile: openFile,
      connect: connect,
      createFile: createFile,
      changeFile: changeFile,
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
    try { handleInitialResult(await storage.restore()); }
    catch (error) {
      runtime.loading = false;
      showConnectionFailure(error);
    }
  }

  initialize();
}(window));
