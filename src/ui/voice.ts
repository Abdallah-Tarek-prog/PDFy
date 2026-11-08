// Voice notes: recording with a live level meter, and a small player that opens on the note.

import { openDialog } from './dialogs';
import { h, icon, toast } from './dom';

const clock = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

/** Records from the microphone. Returns the recording, or null if cancelled. */
export async function recordVoice(): Promise<Blob | null> {
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (err) { toast(`The microphone could not be used. ${(err as Error).message}`, 'error'); return null; }

  let audio: AudioContext | null = null;
  let analyser: AnalyserNode;
  let rec: MediaRecorder;
  let ended: Promise<void>;
  const chunks: Blob[] = [];
  const releaseMicrophone = () => {
    stream.getTracks().forEach(t => t.stop());
    if (audio) void audio.close().catch(() => {});
  };
  try {
    audio = new AudioContext();
    analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) ?? '';
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    ended = new Promise<void>(res => { rec.onstop = () => res(); });
    rec.start(500);
  } catch (err) {
    releaseMicrophone();
    toast(`Recording could not be started. ${(err as Error).message}`, 'error');
    return null;
  }
  const levels = new Uint8Array(analyser.fftSize);

  const time = h('div', { class: 'rec-time' }, '0:00');
  const ring = h('div', { class: 'rec-ring' }, icon('mic', 30));
  const state = h('div', { class: 'rec-state' }, 'Recording');
  const pauseBtn = h('button', { class: 'btn' }, 'Pause');
  const body = h('div', { class: 'rec-box' }, ring, time, state, h('div', { class: 'rec-actions' }, pauseBtn));

  let elapsed = 0, last = performance.now(), raf = 0;
  const tick = () => {
    const now = performance.now();
    if (rec.state === 'recording') elapsed += now - last;
    last = now;
    time.textContent = clock(elapsed / 1000);
    analyser.getByteTimeDomainData(levels);
    let peak = 0;
    for (const v of levels) peak = Math.max(peak, Math.abs(v - 128));
    ring.style.setProperty('--level', String(rec.state === 'recording' ? Math.min(1, peak / 64) : 0));
    raf = requestAnimationFrame(tick);
  };
  tick();
  pauseBtn.addEventListener('click', () => {
    if (rec.state === 'recording') { rec.pause(); pauseBtn.textContent = 'Resume'; state.textContent = 'Paused'; }
    else if (rec.state === 'paused') { rec.resume(); pauseBtn.textContent = 'Pause'; state.textContent = 'Recording'; }
  });

  const keep = await openDialog('Voice note', body, [{ label: 'Cancel', value: false }, { label: 'Stop', value: true, primary: true }], false);
  cancelAnimationFrame(raf);
  if (rec.state !== 'inactive') rec.stop();
  await ended;
  releaseMicrophone();
  if (!keep || !chunks.length) return null;
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });

  // Listen back before pinning it.
  const url = URL.createObjectURL(blob);
  try {
    const player = h('audio', { controls: true, src: url, class: 'rec-preview' });
    const choice = await openDialog<'keep' | 'again' | 'cancel'>('Keep this voice note?', h('div', { class: 'rec-box' }, player, h('p', { class: 'muted' }, `${clock(elapsed / 1000)} recorded.`)),
      [{ label: 'Discard', value: 'cancel' }, { label: 'Record again', value: 'again' }, { label: 'Keep', value: 'keep', primary: true }], 'cancel');
    player.pause();
    if (choice === 'again') return recordVoice();
    return choice === 'keep' ? blob : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let open: { close(): void } | null = null;
export function closeVoicePlayer() { open?.close(); }

export interface VoiceActions { save(): void; remove(): void }

/** A small player beside the note: play, pause, seek, speed, save a copy, delete. */
export function showVoicePlayer(blob: Blob, title: string, at: { x: number; y: number }, actions: VoiceActions) {
  open?.close();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const playBtn = h('button', { class: 'vp-play', title: 'Play', 'aria-label': 'Play' }, icon('play', 16));
  const bar = h('input', { class: 'vp-seek', type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Position' });
  const time = h('span', { class: 'vp-time' }, '0:00');
  const speeds = [1, 1.25, 1.5, 2, 0.75];
  let sp = 0;
  const speed = h('button', { class: 'btn small vp-speed', title: 'Playback speed' }, '1×');
  const card = h('div', { class: 'voice-player', role: 'dialog', 'aria-label': title },
    h('div', { class: 'vp-head' }, icon('mic', 14), h('span', { class: 'vp-title' }, title),
      h('button', { class: 'icon-btn small', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('close', 13))),
    h('div', { class: 'vp-row' }, playBtn, bar, time),
    h('div', { class: 'vp-row vp-tools' }, speed,
      h('button', { class: 'btn small', onclick: () => actions.save() }, 'Save a copy'),
      h('button', { class: 'btn small danger', onclick: () => { close(); actions.remove(); } }, 'Delete')));

  // Recordings made in a browser often report no length until played through, so ask for it.
  const length = () => (Number.isFinite(audio.duration) ? audio.duration : 0);
  const sync = () => {
    playBtn.replaceChildren(icon(audio.paused ? 'play' : 'pause', 16));
    playBtn.title = audio.paused ? 'Play' : 'Pause';
    const d = length();
    if (d && document.activeElement !== bar) bar.value = String(Math.round((audio.currentTime / d) * 1000));
    time.textContent = d ? `${clock(audio.currentTime)} / ${clock(d)}` : clock(audio.currentTime);
  };
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration === Infinity) {
      audio.currentTime = 1e9;
      audio.addEventListener('timeupdate', function fix() { audio.removeEventListener('timeupdate', fix); audio.currentTime = 0; sync(); });
    }
    sync();
  });
  for (const ev of ['play', 'pause', 'timeupdate', 'ended', 'durationchange']) audio.addEventListener(ev, sync);
  playBtn.addEventListener('click', () => { if (audio.paused) void audio.play().catch(err => toast(`The voice note could not be played. ${(err as Error).message}`, 'error')); else audio.pause(); });
  bar.addEventListener('input', () => { const d = length(); if (d) audio.currentTime = (+bar.value / 1000) * d; });
  speed.addEventListener('click', () => { sp = (sp + 1) % speeds.length; audio.playbackRate = speeds[sp]; speed.textContent = `${speeds[sp]}×`; });

  document.body.append(card);
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(at.y + 8, innerHeight - r.height - 8))}px`;

  const away = (e: PointerEvent) => { if (!card.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === ' ' && card.contains(document.activeElement)) { e.preventDefault(); playBtn.click(); }
  };
  function close() {
    audio.pause();
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
    card.remove();
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    if (open?.close === close) open = null;
  }
  open = { close };
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); }, 0);
  playBtn.focus();
  void audio.play().catch(() => sync());
}
