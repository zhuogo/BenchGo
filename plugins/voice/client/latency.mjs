const elapsed = (start, end) => Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round(end - start)) : null;

/** Local timing only: never retain transcript, audio, provider or credential data. */
export class CallLatency {
  constructor({ now = Date.now, onChange = () => {} } = {}) { this.now = now; this.onChange = onChange; this.reset(); }
  reset() { this.sequence = 0; this.current = null; this.history = []; this.segments = new Map(); }
  snapshot() {
    const view = row => row && ({ ...row.values, playback: { ...row.values.playback }, segments: row.values.segments.map(value => ({ ...value })), tts_first_byte_ms: row.values.tts_first_byte_ms.map(value => ({ ...value })) });
    return { current: view(this.current), history: this.history.map(view) };
  }
  emit() { this.onChange(this.snapshot()); }
  input(id) {
    if (!this.current || this.current.submittedAt !== null) {
      if (this.current) this.history.push(this.current);
      if (this.history.length > 16) this.history.shift();
      this.current = { utteranceId: id, anchor: null, submittedAt: null, values: {
        turn_id: ++this.sequence, endpoint_ms: null, transcript_ms: null, submit_ms: null,
        first_token_ms: null, first_audio_ms: null, first_playback_ms: null, speech_to_playback_ms: null,
        interrupted: false, tts_first_byte_ms: [], segments: [], playback: {},
      } };
    } else {
      this.current.utteranceId = id; this.current.anchor = null;
      this.current.values.endpoint_ms = this.current.values.transcript_ms = null;
    }
    this.emit();
  }
  recognition(id, metadata, final = false) {
    const row = this.current;
    if (!row || row.utteranceId !== id || row.submittedAt !== null) return;
    if (Number.isFinite(metadata.speechEndedAt)) row.anchor = metadata.speechEndedAt;
    if (Number.isFinite(metadata.endpointAt)) row.values.endpoint_ms = elapsed(row.anchor, metadata.endpointAt);
    if (final) row.values.transcript_ms = elapsed(row.anchor, Number.isFinite(metadata.finalizedAt) ? metadata.finalizedAt : this.now());
    this.emit();
  }
  submit() {
    const row = this.current; if (!row || row.submittedAt !== null) return;
    row.submittedAt = this.now(); row.values.submit_ms = elapsed(row.anchor, row.submittedAt); this.emit();
  }
  token() {
    const row = this.current; if (!row || row.submittedAt === null || row.tokenAt !== undefined) return;
    row.tokenAt = this.now(); row.values.first_token_ms = elapsed(row.anchor, row.tokenAt); this.emit();
  }
  bind(id) {
    if (!this.current || this.current.submittedAt === null) return;
    this.segments.set(id, this.current);
    this.current.firstSegment ??= id;
    while (this.segments.size > 128) this.segments.delete(this.segments.keys().next().value);
  }
  tts(event) {
    const row = this.segments.get(event.id);
    if (!row || row !== this.current) return;
    const segment = this.segment(row, event.id);
    if (segment) {
      for (const key of ['request_wait_ms', 'elapsed_ms', 'audio_ms', 'chunks', 'max_audio_gap_ms', 'backpressure_ms']) {
        if (Number.isFinite(event[key])) segment[key] = event[key];
      }
      if (event.type === 'tts.start') segment.request_ms = elapsed(row.anchor, event.at);
      if (event.type === 'tts.first_audio') segment.first_byte_ms = event.first_byte_ms;
      if (event.type === 'tts.end') segment.status = event.status;
    }
    if (event.type === 'tts.first_audio') {
      if (row.firstSegment === event.id && row.audioAt === undefined) { row.audioAt = event.at; row.values.first_audio_ms = elapsed(row.anchor, event.at); }
      if (row.values.tts_first_byte_ms.length < 32) row.values.tts_first_byte_ms.push({ segment_id: event.id, first_byte_ms: event.first_byte_ms });
    }
    this.emit();
  }
  segment(row, id) {
    let segment = row.values.segments.find(value => value.segment_id === id);
    if (!segment && row.values.segments.length < 32) { segment = { segment_id: id }; row.values.segments.push(segment); }
    return segment;
  }
  playback(event, started = false) {
    const row = this.segments.get(event.id);
    if (!row || row !== this.current) return;
    for (const key of ['buffer_ms', 'first_buffer_ms', 'underruns', 'gap_ms', 'bufferedSeconds', 'segment_gap_ms']) {
      if (Number.isFinite(event[key])) row.values.playback[key] = event[key];
    }
    const segment = this.segment(row, event.id);
    if (event.event === 'segment_started' && Number.isFinite(event.render_time_ms)) {
      if (segment) segment.render_start_ms = event.render_time_ms;
      if (row.lastRenderEnd !== undefined) {
        const gap = elapsed(row.lastRenderEnd, event.render_time_ms);
        if (segment) segment.previous_gap_ms = gap;
        row.values.playback.segment_gap_ms = (row.values.playback.segment_gap_ms || 0) + gap;
      }
    }
    if (event.event === 'segment_ended' && Number.isFinite(event.render_time_ms)) {
      if (segment) segment.render_end_ms = event.render_time_ms;
      row.lastRenderEnd = event.render_time_ms;
    }
    if (started && event.id === row.firstSegment && row.playbackAt === undefined) {
      row.playbackAt = this.now(); row.values.first_playback_ms = elapsed(row.submittedAt, row.playbackAt);
      row.values.speech_to_playback_ms = elapsed(row.anchor, row.playbackAt);
    }
    this.emit();
  }
  interrupt() { if (this.current && this.current.submittedAt !== null) { this.current.values.interrupted = true; this.emit(); } }
  clearSegments() { this.segments.clear(); }
}
