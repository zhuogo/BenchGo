(() => {
  const status = document.getElementById('startup-status');
  setTimeout(() => {
    if (status && !status.dataset.phase) status.textContent = '仍在准备中，请稍候…';
  }, 20000);
})();
