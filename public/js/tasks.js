(function (global) {
  'use strict';

  const state = global.Taskboard.state;
  const priorities = new Set(['low', 'medium', 'high', 'urgent']);

  function now() {
    return new Date().toISOString();
  }

  function findTask(board, taskId) {
    return board.tasks.find(function (task) { return task.id === taskId; });
  }

  function assertColumn(board, columnId) {
    if (!board.columns.some(function (column) { return column.id === columnId; })) {
      throw new Error('La columna elegida no existe.');
    }
  }

  function normalizeColumn(board, columnId, timestamp) {
    board.tasks
      .filter(function (task) { return task.columnId === columnId; })
      .sort(function (a, b) { return a.order - b.order; })
      .forEach(function (task, index) {
        if (task.order !== index) {
          task.order = index;
          if (timestamp) task.updatedAt = timestamp;
        }
      });
  }

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function create(input) {
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    if (!title) throw new Error('Escribe un título para la tarea.');
    if (title.length > 120 || description.length > 1000) throw new Error('El título o la descripción supera el límite permitido.');
    const board = state.get();
    const columnId = input.columnId || board.columns[0].id;
    const priority = priorities.has(input.priority) ? input.priority : 'medium';
    assertColumn(board, columnId);
    const timestamp = now();
    const task = {
      id: createId(), title: title, description: description, priority: priority,
      columnId: columnId,
      order: board.tasks.filter(function (item) { return item.columnId === columnId; }).length,
      createdAt: timestamp, updatedAt: timestamp
    };
    state.updateActiveBoard(function (draft) { draft.tasks.push(task); }, 'task-created');
    return task.id;
  }

  function edit(taskId, input) {
    const current = findTask(state.get(), taskId);
    if (!current) throw new Error('No se encontró la tarea que quieres editar.');
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    if (!title) throw new Error('Escribe un título para la tarea.');
    if (title.length > 120 || description.length > 1000) throw new Error('El título o la descripción supera el límite permitido.');
    const columnId = input.columnId || current.columnId;
    assertColumn(state.get(), columnId);
    const priority = priorities.has(input.priority) ? input.priority : current.priority;
    const timestamp = now();
    state.updateActiveBoard(function (draft) {
      const task = findTask(draft, taskId);
      const oldColumnId = task.columnId;
      task.title = title;
      task.description = description;
      task.priority = priority;
      if (columnId !== oldColumnId) {
        task.columnId = columnId;
        task.order = draft.tasks.filter(function (item) { return item.columnId === columnId && item.id !== taskId; }).length;
        normalizeColumn(draft, oldColumnId, timestamp);
      }
      task.updatedAt = timestamp;
      normalizeColumn(draft, columnId, timestamp);
    }, 'task-edited');
  }

  function remove(taskId) {
    const current = findTask(state.get(), taskId);
    if (!current) return false;
    const timestamp = now();
    state.updateActiveBoard(function (draft) {
      draft.tasks = draft.tasks.filter(function (task) { return task.id !== taskId; });
      normalizeColumn(draft, current.columnId, timestamp);
    }, 'task-deleted');
    return true;
  }

  function setPriority(taskId, priority) {
    if (!priorities.has(priority)) throw new Error('La prioridad seleccionada no es válida.');
    const current = findTask(state.get(), taskId);
    if (!current || current.priority === priority) return false;
    state.updateActiveBoard(function (draft) {
      const task = findTask(draft, taskId);
      task.priority = priority;
      task.updatedAt = now();
    }, 'task-priority-changed');
    return true;
  }

  function move(taskId, columnId, beforeTaskId) {
    const original = findTask(state.get(), taskId);
    if (!original) return false;
    assertColumn(state.get(), columnId);
    if (beforeTaskId === taskId) return false;
    const originalColumnId = original.columnId;
    const currentOrder = state.get().tasks
      .filter(function (item) { return item.columnId === originalColumnId; })
      .sort(function (a, b) { return a.order - b.order; })
      .map(function (item) { return item.id; });
    const targetOrder = state.get().tasks
      .filter(function (item) { return item.columnId === columnId && item.id !== taskId; })
      .sort(function (a, b) { return a.order - b.order; })
      .map(function (item) { return item.id; });
    let nextIndex = beforeTaskId ? targetOrder.indexOf(beforeTaskId) : -1;
    if (nextIndex < 0) nextIndex = targetOrder.length;
    targetOrder.splice(nextIndex, 0, taskId);
    if (originalColumnId === columnId && currentOrder.every(function (id, index) { return id === targetOrder[index]; })) return false;
    const timestamp = now();
    state.updateActiveBoard(function (draft) {
      const task = findTask(draft, taskId);
      const targetTasks = draft.tasks
        .filter(function (item) { return item.columnId === columnId && item.id !== taskId; })
        .sort(function (a, b) { return a.order - b.order; });
      let insertionIndex = beforeTaskId
        ? targetTasks.findIndex(function (item) { return item.id === beforeTaskId; })
        : -1;
      if (insertionIndex < 0) insertionIndex = targetTasks.length;
      targetTasks.splice(insertionIndex, 0, task);
      task.columnId = columnId;
      task.updatedAt = timestamp;
      targetTasks.forEach(function (item, index) {
        if (item.order !== index) {
          item.order = index;
          item.updatedAt = timestamp;
        }
      });
      if (originalColumnId !== columnId) normalizeColumn(draft, originalColumnId, timestamp);
    }, 'task-moved');
    return true;
  }

  function updateBoardSettings(input) {
    const board = state.get();
    const boardTitle = String(input.boardTitle || '').trim();
    if (!boardTitle || boardTitle.length > 80) throw new Error('El nombre del tablero debe tener entre 1 y 80 caracteres.');
    const names = input.columnNames;
    if (!Array.isArray(names) || names.length !== board.columns.length || names.some(function (name) { return !String(name).trim() || String(name).trim().length > 40; })) {
      throw new Error('Cada columna necesita un nombre de entre 1 y 40 caracteres.');
    }
    state.updateActiveBoard(function (draft) {
      draft.settings.boardTitle = boardTitle;
      draft.columns.forEach(function (column, index) { column.name = String(names[index]).trim(); });
    }, 'settings-changed');
  }

  global.Taskboard.tasks = {
    create: create,
    edit: edit,
    remove: remove,
    setPriority: setPriority,
    move: move,
    updateBoardSettings: updateBoardSettings
  };
}(window));
