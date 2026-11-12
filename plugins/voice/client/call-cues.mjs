// Local, quiet cues: no network, speech queue or persistent audio context.
export function playCallCue(kind, { context } = {}) {
  const ownContext = !context;
  const nodes = [];
  let timer, settled = false, complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const [oscillator, gain] of nodes) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch {}
      try { oscillator.disconnect(); gain.disconnect(); } catch {}
    }
    if (ownContext && context?.state !== 'closed') {
      try { Promise.resolve(context?.close()).catch(() => {}); } catch {}
    }
    complete();
  };
  try {
    if (!context) {
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio) return null;
      context = new Audio();
    }
    if (context.state === 'closed' || !ownContext && context.state !== 'running') return null;
    const start = () => {
      if (settled) return;
      if (context.state !== 'running') { finish(); return; }
      try {
        const notes = kind === 'connected' ? [440, 660] : [660, 440];
        const at = context.currentTime + .008;
        for (const [index, frequency] of notes.entries()) {
          const oscillator = context.createOscillator(), gain = context.createGain();
          nodes.push([oscillator, gain]);
          const time = at + index * .125;
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, time);
          gain.gain.setValueAtTime(0, time);
          gain.gain.linearRampToValueAtTime(.045, time + .012);
          gain.gain.linearRampToValueAtTime(.028, time + .045);
          gain.gain.linearRampToValueAtTime(0, time + .12);
          oscillator.connect(gain); gain.connect(context.destination);
          if (index === notes.length - 1) oscillator.onended = finish;
          oscillator.start(time); oscillator.stop(time + .12);
        }
      } catch { finish(); }
    };
    // Autoplay/device failures must never keep a context alive or start late.
    timer = setTimeout(finish, 800); timer?.unref?.();
    if (context.state === 'running') start();
    else Promise.resolve(context.resume()).then(start, finish);
    return { finished, cancel: finish };
  } catch { finish(); return null; }
}
