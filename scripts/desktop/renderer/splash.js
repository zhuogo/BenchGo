(() => {
  const status = document.getElementById('startup-status');
  const wait = document.getElementById('startup-wait');
  let timer;

  function trackWait() {
    clearTimeout(timer);
    wait.textContent = '';
    timer = setTimeout(() => { wait.textContent = '这一步耗时较长，请稍候'; }, 20_000);
  }

  window.addEventListener('benchgo-startup-stage', ({ detail: { label } }) => {
    renderLoadingStatus(status, label);
    trackWait();
  });
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  renderLoadingStatus(status);
  trackWait();
})();
