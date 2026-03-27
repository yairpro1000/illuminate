/* ============================================================
   ILLUMINATE Evening — single-event page wrapper
   Strips the tab chrome from evenings.js and shows only
   the first upcoming event card.
   ============================================================ */
(function () {
  'use strict';
  const grid = document.getElementById('events-grid');
  if (!grid) return;

  const observer = new MutationObserver(function () {
    const upcomingPanel = grid.querySelector('#tab-upcoming');
    if (!upcomingPanel) return;
    const firstCard = upcomingPanel.querySelector('.event-card');
    if (!firstCard) return;
    observer.disconnect();

    // Move the first card out of the tab structure into a plain grid wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'events-grid';
    wrapper.appendChild(firstCard);
    grid.innerHTML = '';
    grid.appendChild(wrapper);
  });

  observer.observe(grid, { childList: true });
})();
