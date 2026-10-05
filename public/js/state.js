(function (global) {
  'use strict';

  const initialColumns = [
    { id: 'todo', name: 'Por hacer' },
    { id: 'in-progress', name: 'En proceso' },
    { id: 'testing', name: 'Testing' },
    { id: 'done', name: 'Completado' }
  ];
  const listeners = new Set();
  let file = { version: 2, boards: [] };
  let activeBoardId = null;

  function clone(value) {
    if (typeof global.structuredClone === 'function') return global.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function createId(prefix) {
    const random = global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    return (prefix || 'board-') + random;
  }

  function createInitialBoard(title) {
    return {
      id: createId('board-'),
      settings: { boardTitle: String(title || 'Mi tablero').trim() || 'Mi tablero' },
      columns: initialColumns.map(function (column) { return { ...column }; }),
      tasks: []
    };
  }

  function createInitialFile() {
    return { version: 2, boards: [] };
  }

  function getFile() { return clone(file); }
  function getBoards() { return clone(file.boards); }
  function getActiveBoardId() { return activeBoardId; }

  function getActiveBoard() {
    const board = file.boards.find(function (item) { return item.id === activeBoardId; });
    return board ? clone(board) : null;
  }

  function publish(reason, persist) {
    const snapshot = getFile();
    listeners.forEach(function (listener) {
      try { listener(snapshot, reason || 'change', Boolean(persist)); }
      catch (error) { console.error('No se pudo notificar el cambio de estado.', error); }
    });
  }

  function replaceFile(nextFile, reason, persist) {
    file = clone(nextFile);
    activeBoardId = null;
    publish(reason || 'file-replaced', persist);
  }

  function selectBoard(boardId) {
    if (boardId !== null && !file.boards.some(function (board) { return board.id === boardId; })) {
      throw new Error('No se encontró el tablero que quieres abrir.');
    }
    activeBoardId = boardId;
    publish('board-selected', false);
  }

  function updateBoard(boardId, updater, reason) {
    const nextFile = clone(file);
    const board = nextFile.boards.find(function (item) { return item.id === boardId; });
    if (!board) throw new Error('No se encontró el tablero que quieres modificar.');
    updater(board);
    file = nextFile;
    publish(reason || 'board-updated', true);
    return clone(board);
  }

  function updateActiveBoard(updater, reason) {
    if (!activeBoardId) throw new Error('Abre un tablero antes de modificarlo.');
    return updateBoard(activeBoardId, updater, reason);
  }

  function addBoard(board, select) {
    const nextFile = clone(file);
    const nextBoard = clone(board || createInitialBoard());
    if (!nextBoard.id) nextBoard.id = createId('board-');
    if (nextFile.boards.some(function (item) { return item.id === nextBoard.id; })) {
      throw new Error('Ya existe un tablero con ese identificador.');
    }
    nextFile.boards.push(nextBoard);
    file = nextFile;
    if (select) activeBoardId = nextBoard.id;
    publish('board-added', true);
    return clone(nextBoard);
  }

  function createBoard(title, select) {
    return addBoard(createInitialBoard(title), select);
  }

  function deleteBoard(boardId) {
    if (!file.boards.some(function (board) { return board.id === boardId; })) return false;
    file = {
      version: 2,
      boards: file.boards.filter(function (board) { return board.id !== boardId; })
    };
    if (activeBoardId === boardId) activeBoardId = null;
    publish('board-deleted', true);
    return true;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return function unsubscribe() { listeners.delete(listener); };
  }

  global.Taskboard = global.Taskboard || {};
  global.Taskboard.state = {
    createInitialFile: createInitialFile,
    createInitialBoard: createInitialBoard,
    get: getActiveBoard,
    getFile: getFile,
    getBoards: getBoards,
    getActiveBoard: getActiveBoard,
    getActiveBoardId: getActiveBoardId,
    replaceFile: replaceFile,
    selectBoard: selectBoard,
    updateActiveBoard: updateActiveBoard,
    updateBoard: updateBoard,
    addBoard: addBoard,
    createBoard: createBoard,
    deleteBoard: deleteBoard,
    subscribe: subscribe
  };
}(window));
