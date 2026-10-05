(function (global) {
  'use strict';

  const validPriorities = new Set(['low', 'medium', 'high', 'urgent']);
  const requiredColumnIds = ['todo', 'in-progress', 'testing', 'done'];
  let writeQueue = Promise.resolve();
  let statusListener = function () {};

  function invalid(message) {
    throw new Error('El JSON no tiene un formato válido: ' + message);
  }

  function validateTaskData(task, columnIds, taskIds, orderKeys) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) invalid('hay una tarea mal formada.');
    const id = typeof task.id === 'string' ? task.id.trim() : '';
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const description = typeof task.description === 'string' ? task.description : '';
    const columnId = task.columnId;
    if (!id || id.length > 120 || taskIds.has(id)) invalid('los identificadores de tarea deben ser únicos dentro del tablero.');
    if (!title || title.length > 120) invalid('cada tarea necesita un título de hasta 120 caracteres.');
    if (description.length > 1000) invalid('una descripción supera los 1000 caracteres.');
    if (!validPriorities.has(task.priority)) invalid('hay una prioridad desconocida.');
    if (!columnIds.has(columnId)) invalid('una tarea apunta a una columna inexistente.');
    if (!Number.isInteger(task.order) || task.order < 0) invalid('el orden de una tarea no es válido.');
    const orderKey = columnId + ':' + task.order;
    if (orderKeys.has(orderKey)) invalid('hay dos tareas con la misma posición en una columna.');
    const createdAt = typeof task.createdAt === 'string' ? task.createdAt : '';
    const updatedAt = typeof task.updatedAt === 'string' ? task.updatedAt : '';
    if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) invalid('una fecha de tarea no es válida.');
    taskIds.add(id);
    orderKeys.add(orderKey);
    return {
      id: id,
      title: title,
      description: description,
      priority: task.priority,
      columnId: columnId,
      order: task.order,
      createdAt: createdAt,
      updatedAt: updatedAt
    };
  }

  function validateTask(task) {
    return validateTaskData(task, new Set(requiredColumnIds), new Set(), new Set());
  }

  function validateBoard(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('hay un tablero mal formado.');
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id || id.length > 120) invalid('cada tablero necesita un id válido.');
    if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) invalid('falta la configuración de un tablero.');
    const boardTitle = typeof value.settings.boardTitle === 'string' ? value.settings.boardTitle.trim() : '';
    if (!boardTitle || boardTitle.length > 80) invalid('el nombre de cada tablero debe tener entre 1 y 80 caracteres.');
    if (!Array.isArray(value.columns) || value.columns.length !== requiredColumnIds.length) invalid('cada tablero debe contener las cuatro columnas.');
    const columnIds = new Set();
    const columns = value.columns.map(function (column, index) {
      if (!column || typeof column !== 'object' || Array.isArray(column)) invalid('hay una columna mal formada.');
      const columnId = typeof column.id === 'string' ? column.id : '';
      const name = typeof column.name === 'string' ? column.name.trim() : '';
      if (columnId !== requiredColumnIds[index] || columnIds.has(columnId)) invalid('las columnas deben conservar sus identificadores y orden originales.');
      if (!name || name.length > 40) invalid('cada columna necesita un nombre de entre 1 y 40 caracteres.');
      columnIds.add(columnId);
      return { id: columnId, name: name };
    });
    if (!Array.isArray(value.tasks)) invalid('la lista de tareas de un tablero no es válida.');
    const taskIds = new Set();
    const orderKeys = new Set();
    const tasks = value.tasks.map(function (task) { return validateTaskData(task, columnIds, taskIds, orderKeys); });
    return { id: id, settings: { boardTitle: boardTitle }, columns: columns, tasks: tasks };
  }

  function validateFileData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('se esperaba un objeto para el archivo.');
    if (value.version !== 2) invalid('la versión del archivo debe ser 2.');
    if (!Array.isArray(value.boards)) invalid('boards debe ser una lista.');
    const boardIds = new Set();
    const boards = value.boards.map(function (rawBoard) {
      const board = validateBoard(rawBoard);
      if (boardIds.has(board.id)) invalid('los id de los tableros deben ser únicos.');
      boardIds.add(board.id);
      return board;
    });
    return { version: 2, boards: boards };
  }

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return 'board-' + global.crypto.randomUUID();
    return 'board-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function normalizeFileData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('se esperaba un objeto para el archivo.');
    if (value.version === 1) {
      const legacyBoard = {
        id: typeof value.id === 'string' && value.id.trim() ? value.id : createId(),
        settings: value.settings,
        columns: value.columns,
        tasks: value.tasks
      };
      return { fileData: validateFileData({ version: 2, boards: [legacyBoard] }), migrated: true };
    }
    return { fileData: validateFileData(value), migrated: false };
  }

  function apiError(response, body) {
    const error = new Error(body && typeof body.error === 'string' ? body.error : 'El servidor respondió con HTTP ' + response.status + '.');
    error.status = response.status;
    return error;
  }

  async function request(path, options) {
    let response;
    try {
      response = await global.fetch(path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options || {}));
    } catch (cause) {
      const error = new Error('No se pudo conectar con el servidor de Taskboard. Comprueba que siga ejecutándose.');
      error.cause = cause;
      error.isConnectionError = true;
      throw error;
    }
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch (error) { /* usa el estado HTTP */ }
      throw apiError(response, body);
    }
    return response;
  }

  async function load() {
    const response = await request('/api/data', { method: 'GET', headers: { Accept: 'application/json' } });
    let parsed;
    try { parsed = await response.json(); }
    catch (error) { throw new Error('El servidor devolvió una respuesta JSON no válida.'); }
    return validateFileData(parsed);
  }

  function serialize(fileData) {
    return JSON.stringify(validateFileData(fileData), null, 2) + '\n';
  }

  function save(fileData) {
    let snapshot;
    try { snapshot = serialize(fileData); }
    catch (error) { return Promise.reject(error); }
    const operation = writeQueue.catch(function () {}).then(async function () {
      statusListener('saving', 'Guardando...');
      try {
        await request('/api/data', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: snapshot
        });
        statusListener('saved', 'Sincronizado');
      } catch (error) {
        statusListener('error', 'Error al guardar');
        throw error;
      }
    });
    writeQueue = operation;
    return operation;
  }

  async function readImportFile(file) {
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('El archivo importado no contiene JSON válido.');
      throw error;
    }
    return normalizeFileData(parsed).fileData;
  }

  function exportText(fileData) { return serialize(fileData); }
  function onStatus(listener) { statusListener = listener; }

  function describeError(error) {
    if (!error) return 'Se produjo un error desconocido.';
    if (error.isConnectionError) return 'No se pudo guardar el archivo. Comprueba que el servidor de Taskboard sigue ejecutándose.';
    return error.message || String(error);
  }

  global.Taskboard = global.Taskboard || {};
  global.Taskboard.storage = {
    load: load,
    save: save,
    validateTask: validateTask,
    validateBoard: validateBoard,
    validateFileData: validateFileData,
    normalizeFileData: normalizeFileData,
    readImportFile: readImportFile,
    exportText: exportText,
    onStatus: onStatus,
    describeError: describeError
  };
}(window));
