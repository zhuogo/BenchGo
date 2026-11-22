/** Keep the live status readable as one phrase while animating its visual characters. */
function renderLoadingStatus(status, text = status.textContent, loading = true) {
  status.setAttribute('aria-label', text);
  if (!loading) {
    status.textContent = text;
    return;
  }

  const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment);
  const label = status.ownerDocument.createElement('span');
  label.className = 'bg-loading-text';
  label.setAttribute('aria-hidden', 'true');
  label.style.setProperty('--loading-cycle', `${Math.max(1600, characters.length * 75 + 800)}ms`);
  characters.forEach((character, index) => {
    const letter = status.ownerDocument.createElement('span');
    letter.className = 'bg-loading-character';
    letter.style.animationDelay = `${index * 75}ms`;
    letter.textContent = character;
    label.append(letter);
  });
  status.replaceChildren(label);
}
