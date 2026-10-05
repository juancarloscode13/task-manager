(function (global) {
  'use strict';

  function attach(options) {
    const board = document.querySelector('#board');
    let draggedTaskId = null;
    let hoveredList = null;

    function clearIndicators() {
      board.querySelectorAll('.is-drop-target, .is-drop-before').forEach(function (node) {
        node.classList.remove('is-drop-target', 'is-drop-before');
      });
      hoveredList = null;
    }

    function insertionTarget(list, pointerY) {
      const cards = Array.from(list.querySelectorAll('[data-task-id]')).filter(function (card) {
        return card.dataset.taskId !== draggedTaskId;
      });
      for (const card of cards) {
        const bounds = card.getBoundingClientRect();
        if (pointerY < bounds.top + bounds.height / 2) return card;
      }
      return null;
    }

    board.addEventListener('dragstart', function (event) {
      const card = event.target.closest('[data-task-id]');
      if (!card || !options.isReady()) {
        event.preventDefault();
        return;
      }
      draggedTaskId = card.dataset.taskId;
      card.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedTaskId);
    });

    board.addEventListener('dragover', function (event) {
      const list = event.target.closest('.task-list');
      if (!draggedTaskId || !list || !options.isReady()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (hoveredList !== list) {
        clearIndicators();
        hoveredList = list;
      }
      list.classList.add('is-drop-target');
      board.querySelectorAll('.is-drop-before').forEach(function (node) { node.classList.remove('is-drop-before'); });
      const before = insertionTarget(list, event.clientY);
      if (before) before.classList.add('is-drop-before');
    });

    board.addEventListener('drop', function (event) {
      const list = event.target.closest('.task-list');
      if (!draggedTaskId || !list || !options.isReady()) return;
      event.preventDefault();
      const before = insertionTarget(list, event.clientY);
      const taskId = event.dataTransfer.getData('text/plain') || draggedTaskId;
      try {
        options.onMove(taskId, list.dataset.columnId, before ? before.dataset.taskId : null);
      } catch (error) {
        global.Taskboard.ui.showError(error.message || String(error), false);
      }
      clearIndicators();
    });

    board.addEventListener('dragend', function (event) {
      const card = event.target.closest('[data-task-id]');
      if (card) card.classList.remove('is-dragging');
      draggedTaskId = null;
      clearIndicators();
    });

    board.addEventListener('dragleave', function (event) {
      const list = event.target.closest('.task-list');
      if (list && !list.contains(event.relatedTarget)) list.classList.remove('is-drop-target');
    });
  }

  global.Taskboard = global.Taskboard || {};
  global.Taskboard.dragdrop = { attach: attach };
}(window));
