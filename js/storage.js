(function (global) {
  'use strict';

  const databaseName = 'taskboard-local-files';
  const storeName = 'file-handles';
  const recordKey = 'primary-data-json';
  const validPriorities = new Set(['low', 'medium', 'high', 'urgent']);
  const requiredColumnIds = ['todo', 'in-progress', 'testing', 'done'];
  let databasePromise = null;
  let fileHandle = null;
  let writeQueue = Promise.resolve();
  let statusListener = function () {};

  function isAvailable() {
    return typeof global.showOpenFilePicker === 'function' && typeof global.showSaveFilePicker === 'function';
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB no está disponible en este navegador.'));
        return;
      }
      let request;
      try { request = global.indexedDB.open(databaseName, 1); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('No se pudo abrir IndexedDB.')); };
      request.onblocked = function () { reject(new Error('IndexedDB está bloqueado por otra pestaña de Taskboard.')); };
    }).catch(function (error) {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  function transaction(mode, action) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        let tx;
        let request;
        try {
          tx = db.transaction(storeName, mode);
          request = action(tx.objectStore(storeName));
        } catch (error) { reject(error); return; }
        tx.oncomplete = function () { resolve(request && request.result); };
        tx.onerror = function () { reject(tx.error || new Error('Falló una operación de IndexedDB.')); };
        tx.onabort = function () { reject(tx.error || new Error('Se canceló una operación de IndexedDB.')); };
      });
    });
  }

  function getSavedHandle() {
    return transaction('readonly', function (store) { return store.get(recordKey); });
  }

  function saveHandle(handle) {
    return transaction('readwrite', function (store) {
      return store.put({ handle: handle, fileName: handle.name, savedAt: new Date().toISOString() }, recordKey);
    });
  }

  function clearSavedHandle() {
    return transaction('readwrite', function (store) { return store.delete(recordKey); });
  }

  function permission(handle) {
    if (typeof handle.queryPermission !== 'function') return Promise.resolve('denied');
    return handle.queryPermission({ mode: 'readwrite' });
  }

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
    return {
      id: id,
      settings: { boardTitle: boardTitle },
      columns: columns,
      tasks: tasks
    };
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

  async function readHandle(handle) {
    if (handle.name !== 'data.json') throw new Error('El archivo elegido se llama “' + handle.name + '”. Elige el archivo data.json.');
    let fileObject;
    try { fileObject = await handle.getFile(); }
    catch (error) {
      if (error.name === 'NotFoundError') throw new Error('No se encuentra data.json. Puede haberse movido o eliminado; vuelve a elegir el archivo.');
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(await fileObject.text()); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('data.json contiene JSON inválido. Corrígelo o importa un JSON válido para reemplazarlo.');
      throw error;
    }
    return normalizeFileData(parsed);
  }

  async function persistMigration(result, permissionState) {
    if (!result.migrated || permissionState !== 'granted') return '';
    try { await save(result.fileData); return ''; }
    catch (error) { return 'El archivo se abrió, pero no se pudo guardar la migración a versión 2: ' + describeError(error); }
  }

  async function restore() {
    if (!isAvailable()) return { kind: 'unavailable', available: false };
    let saved;
    try { saved = await getSavedHandle(); }
    catch (error) {
      return { kind: 'error', error: new Error('No se pudo recuperar el acceso guardado en IndexedDB: ' + error.message), connected: false };
    }
    if (!saved || !saved.handle) return { kind: 'empty', available: true, connected: false };
    fileHandle = saved.handle;
    let permissionState;
    try { permissionState = await permission(fileHandle); }
    catch (error) {
      return { kind: 'error', error: new Error('No se pudo comprobar el permiso de data.json: ' + error.message), connected: true };
    }
    try {
      const result = await readHandle(fileHandle);
      if (permissionState !== 'granted') {
        return { kind: 'permission', fileData: result.fileData, migrated: result.migrated, connected: true, available: true };
      }
      const warning = await persistMigration(result, permissionState);
      return { kind: 'loaded', fileData: result.fileData, migrated: result.migrated, connected: true, available: true, warning: warning };
    } catch (error) { return { kind: 'error', error: error, connected: true, available: true }; }
  }

  async function selectFile() {
    if (!isAvailable()) throw new Error('File System Access API no está disponible en este navegador o contexto.');
    let handles;
    try {
      handles = await global.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Archivo de datos Taskboard', accept: { 'application/json': ['.json'] } }]
      });
    } catch (error) {
      if (error.name === 'AbortError') return { kind: 'cancelled' };
      throw error;
    }
    const handle = handles[0];
    if (!handle) return { kind: 'cancelled' };
    if (handle.name !== 'data.json') throw new Error('El archivo elegido se llama “' + handle.name + '”. Elige el archivo data.json.');
    fileHandle = handle;
    const permissionState = await permission(handle);
    const warnings = [];
    try { await saveHandle(handle); }
    catch (error) { warnings.push('data.json quedó conectado, pero no se pudo recordar el acceso en IndexedDB: ' + error.message); }
    const result = await readHandle(handle);
    const migrationWarning = await persistMigration(result, permissionState);
    if (migrationWarning) warnings.push(migrationWarning);
    const warning = warnings.join(' ');
    if (permissionState !== 'granted') {
      return { kind: 'permission', fileData: result.fileData, migrated: result.migrated, connected: true, available: true, warning: warning };
    }
    return { kind: 'loaded', fileData: result.fileData, migrated: result.migrated, connected: true, available: true, warning: warning };
  }

  async function connectSaved() {
    if (!fileHandle) throw new Error('No hay un archivo guardado para conceder permiso. Elige data.json desde el selector.');
    let permissionState = await permission(fileHandle);
    if (permissionState !== 'granted' && typeof fileHandle.requestPermission === 'function') {
      permissionState = await fileHandle.requestPermission({ mode: 'readwrite' });
    }
    if (permissionState !== 'granted') throw new Error('El navegador no concedió permiso de lectura y escritura para data.json.');
    const result = await readHandle(fileHandle);
    const warnings = [];
    try { await saveHandle(fileHandle); }
    catch (error) { warnings.push('data.json quedó conectado, pero no se pudo recordar el acceso en IndexedDB: ' + error.message); }
    const migrationWarning = await persistMigration(result, permissionState);
    if (migrationWarning) warnings.push(migrationWarning);
    const warning = warnings.join(' ');
    return { kind: 'loaded', fileData: result.fileData, migrated: result.migrated, connected: true, available: true, warning: warning };
  }

  async function createFile(fileData) {
    if (!isAvailable()) throw new Error('File System Access API no está disponible en este navegador o contexto.');
    let handle;
    try {
      handle = await global.showSaveFilePicker({
        suggestedName: 'data.json',
        types: [{ description: 'Archivo de datos Taskboard', accept: { 'application/json': ['.json'] } }]
      });
    } catch (error) {
      if (error.name === 'AbortError') return { kind: 'cancelled' };
      throw error;
    }
    if (handle.name !== 'data.json') throw new Error('El archivo debe llamarse data.json. Vuelve a elegir ese nombre en el selector.');
    fileHandle = handle;
    let permissionState = await permission(handle);
    if (permissionState !== 'granted' && typeof handle.requestPermission === 'function') {
      permissionState = await handle.requestPermission({ mode: 'readwrite' });
    }
    if (permissionState !== 'granted') throw new Error('El navegador no concedió permiso de lectura y escritura para data.json.');
    let warning = '';
    try { await saveHandle(handle); }
    catch (error) { warning = 'El archivo se creó, pero no se pudo recordar el acceso en IndexedDB: ' + error.message; }
    const validated = validateFileData(fileData);
    await save(validated);
    return { kind: 'loaded', fileData: validated, connected: true, available: true, warning: warning };
  }

  async function authorizeSaved() {
    if (!fileHandle) {
      const saved = await getSavedHandle();
      fileHandle = saved && saved.handle;
    }
    if (!fileHandle) throw new Error('No hay un archivo data.json conectado.');
    let permissionState = await permission(fileHandle);
    if (permissionState !== 'granted' && typeof fileHandle.requestPermission === 'function') {
      permissionState = await fileHandle.requestPermission({ mode: 'readwrite' });
    }
    if (permissionState !== 'granted') throw new Error('El navegador no concedió permiso de escritura para data.json.');
    return true;
  }

  function serialize(fileData) {
    return JSON.stringify(validateFileData(fileData), null, 2) + '\n';
  }

  function save(fileData) {
    let snapshot;
    try { snapshot = serialize(fileData); }
    catch (error) { return Promise.reject(error); }
    const operation = writeQueue.catch(function () {}).then(async function () {
      if (!fileHandle) throw new Error('No hay un archivo data.json conectado. Conéctalo para guardar los cambios.');
      const permissionState = await permission(fileHandle);
      if (permissionState !== 'granted') throw new Error('Se perdió el permiso de escritura de data.json. Vuelve a conectar el archivo para guardar.');
      statusListener('saving', 'Guardando...');
      let writable;
      try {
        writable = await fileHandle.createWritable();
        await writable.write(snapshot);
        await writable.close();
        statusListener('saved', 'Guardado');
      } catch (error) {
        if (writable && typeof writable.abort === 'function') {
          try { await writable.abort(); } catch (abortError) { /* conserva el fallo original */ }
        }
        throw error;
      }
    }).catch(function (error) {
      statusListener('error', 'Error al guardar');
      throw error;
    });
    writeQueue = operation;
    return operation;
  }

  async function clearHandle() {
    fileHandle = null;
    await clearSavedHandle();
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
  function hasHandle() { return Boolean(fileHandle); }
  function onStatus(listener) { statusListener = listener; }

  function describeError(error) {
    if (!error) return 'Se produjo un error desconocido.';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'El permiso para acceder a data.json fue denegado. Vuelve a conectarlo desde la pantalla de archivo.';
    if (error.name === 'NotFoundError') return 'No se encuentra data.json. Puede haberse movido o eliminado; vuelve a elegir el archivo.';
    if (error.name === 'QuotaExceededError') return 'El navegador no pudo completar la escritura. Comprueba el espacio disponible y los permisos del archivo.';
    if (error.name === 'AbortError') return 'Se canceló la operación del archivo.';
    return error.message || String(error);
  }

  global.Taskboard = global.Taskboard || {};
  global.Taskboard.storage = {
    isAvailable: isAvailable,
    restore: restore,
    selectFile: selectFile,
    connectSaved: connectSaved,
    createFile: createFile,
    authorizeSaved: authorizeSaved,
    clearHandle: clearHandle,
    save: save,
    validateTask: validateTask,
    validateBoard: validateBoard,
    validateFileData: validateFileData,
    normalizeFileData: normalizeFileData,
    readImportFile: readImportFile,
    exportText: exportText,
    hasHandle: hasHandle,
    onStatus: onStatus,
    describeError: describeError
  };
}(window));
