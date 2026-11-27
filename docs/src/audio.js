// Procedural Web Audio API sound engine for FX Lab (zero external assets, 100% browser-native).
// Provides three layered, independently controllable audio systems:
//   1) Tactile UI clicks, pentatonic step chimes, split-divider ratchet ticks & context-aware action SFX
//   2) Bespoke continuous ambient soundscapes + live interactive foley for all 26 graphics scenes
//   3) Adaptive procedural ambient-electronic lab soundtrack synced to each effect's category

const STORAGE_SOUND = "fxlab_sound";
const STORAGE_MUSIC = "fxlab_music";

// Musical scales & chord progressions per FX Lab category (warm, non-fatiguing studio palette)
const MUSIC_THEMES = {
  fluids: {
    tempo: 0.50, // 120 BPM 8th/quarter pulse
    chords: [
      [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj7
      [146.83, 220.00, 261.63, 329.63, 440.00], // Dm9
      [116.54, 174.61, 220.00, 293.66, 349.23], // Bbmaj7
      [130.81, 196.00, 261.63, 349.23, 392.00], // Csus4
    ],
    arp: [0, 2, 3, 4, 3, 2, 1, 2],
    tone: "sine",
    cutoff: 1350,
  },
  physics: {
    tempo: 0.46,
    chords: [
      [164.81, 196.00, 246.94, 293.66, 369.99], // Em9
      [130.81, 164.81, 196.00, 246.94, 329.63], // Cmaj7
      [196.00, 246.94, 293.66, 329.63, 392.00], // G6
      [146.83, 196.00, 220.00, 293.66, 369.99], // D6/9
    ],
    arp: [0, 2, 4, 3, 2, 4, 1, 3],
    tone: "triangle",
    cutoff: 1450,
  },
  lighting: {
    tempo: 0.56,
    chords: [
      [110.00, 164.81, 196.00, 246.94, 329.63], // Am9
      [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj7
      [130.81, 196.00, 246.94, 293.66, 392.00], // Cmaj9
      [196.00, 246.94, 293.66, 329.63, 440.00], // G6/9
    ],
    arp: [0, 3, 2, 4, 3, 4, 2, 1],
    tone: "sine",
    cutoff: 1650,
  },
  geometry: {
    tempo: 0.54,
    chords: [
      [146.83, 220.00, 261.63, 329.63, 440.00], // Dm9
      [196.00, 246.94, 293.66, 349.23, 440.00], // G9
      [130.81, 164.81, 196.00, 246.94, 329.63], // Cmaj7
      [110.00, 164.81, 196.00, 246.94, 329.63], // Am9
    ],
    arp: [0, 2, 3, 4, 2, 1, 3, 4],
    tone: "sine",
    cutoff: 1500,
  },
  rendering: {
    tempo: 0.48,
    chords: [
      [146.83, 220.00, 261.63, 329.63, 440.00], // Dm9
      [116.54, 174.61, 220.00, 293.66, 349.23], // Bbmaj7
      [196.00, 233.08, 293.66, 349.23, 440.00], // Gm9
      [110.00, 164.81, 220.00, 293.66, 329.63], // A7sus4
    ],
    arp: [0, 3, 2, 4, 1, 3, 2, 4],
    tone: "triangle",
    cutoff: 1550,
  },
  stylization: {
    tempo: 0.46,
    chords: [
      [130.81, 164.81, 196.00, 246.94, 293.66], // Cmaj9
      [110.00, 164.81, 196.00, 246.94, 329.63], // Am9
      [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj7
      [196.00, 246.94, 293.66, 329.63, 440.00], // G6
    ],
    arp: [0, 1, 2, 4, 3, 2, 4, 1],
    tone: "triangle",
    cutoff: 1700,
  },
};

// Pentatonic / Lydian scale for musical Step 1..8 tab clicks
const STEP_SCALE = [523.25, 587.33, 659.25, 783.99, 880.00, 987.77, 1174.66, 1318.51];

// Per-scene ambient synthesis profiles across all 26 FX Lab effects
const SCENE_AMBIENCE = {
  fire:         { kind: "fire",       baseFreq: 175, q: 1.4, gain: 0.24, detail: "crackle" },
  water:        { kind: "water",      baseFreq: 420, q: 1.1, gain: 0.22, detail: "droplet" },
  clouds:       { kind: "wind",       baseFreq: 520, q: 1.8, gain: 0.16, detail: "air" },
  grass:        { kind: "meadow",     baseFreq: 1450, q: 1.6, gain: 0.14, detail: "bird" },
  fog:          { kind: "cathedral",  baseFreq: 146.83, q: 2.0, gain: 0.16, detail: "organ" },
  destruction:  { kind: "outdoor",    baseFreq: 310, q: 1.0, gain: 0.12, detail: "gravel" },
  collisions:   { kind: "portal",     baseFreq: 92,  q: 3.0, gain: 0.10, detail: "ballistics" },
  motionblur:   { kind: "rotor",      baseFreq: 170, q: 2.8, gain: 0.14, detail: "rotor" },
  dof:          { kind: "rain",       baseFreq: 1050, q: 0.9, gain: 0.14, detail: "night" },
  animation:    { kind: "studio",     baseFreq: 240, q: 1.0, gain: 0.08, detail: "arena" },
  terrain:      { kind: "wind",       baseFreq: 760, q: 2.4, gain: 0.16, detail: "alpine" },
  glass:        { kind: "crystal",    baseFreq: 528, q: 4.0, gain: 0.10, detail: "bowl" },
  shadows:      { kind: "outdoor",    baseFreq: 380, q: 1.1, gain: 0.10, detail: "stone" },
  cloth:        { kind: "cloth",      baseFreq: 480, q: 1.7, gain: 0.15, detail: "flutter" },
  fur:          { kind: "studio",     baseFreq: 260, q: 0.9, gain: 0.09, detail: "cozy" },
  pathtracing:  { kind: "gallery",    baseFreq: 220, q: 3.0, gain: 0.11, detail: "shimmer" },
  gi:           { kind: "gallery",    baseFreq: 246.94, q: 3.0, gain: 0.11, detail: "shimmer" },
  reflections:  { kind: "gallery",    baseFreq: 261.63, q: 3.2, gain: 0.11, detail: "shimmer" },
  portals:      { kind: "portal",     baseFreq: 65.41, q: 3.5, gain: 0.14, detail: "quantum" },
  textures:     { kind: "studio",     baseFreq: 300, q: 1.2, gain: 0.08, detail: "retro" },
  pixel3d:      { kind: "meadow",     baseFreq: 680, q: 1.3, gain: 0.12, detail: "coastal" },
  splats:       { kind: "water",      baseFreq: 540, q: 1.2, gain: 0.12, detail: "waterfall" },
  toon:         { kind: "outdoor",    baseFreq: 440, q: 1.1, gain: 0.09, detail: "breeze" },
  tonemapping:  { kind: "neon",       baseFreq: 120, q: 5.0, gain: 0.13, detail: "rain" },
  aa:           { kind: "studio",     baseFreq: 280, q: 1.0, gain: 0.08, detail: "optic" },
  surface:      { kind: "fire",       baseFreq: 210, q: 1.5, gain: 0.13, detail: "torch" },
  skin:         { kind: "studio",     baseFreq: 220, q: 1.0, gain: 0.08, detail: "warm" },
  ascii:        { kind: "neon",       baseFreq: 110, q: 4.5, gain: 0.12, detail: "crt" },
  hd2d:         { kind: "fire",       baseFreq: 195, q: 1.6, gain: 0.12, detail: "torch" },
  dithering:    { kind: "portal",     baseFreq: 82.41, q: 3.4, gain: 0.11, detail: "crt" },
  materials:    { kind: "gallery",    baseFreq: 246.94, q: 2.8, gain: 0.10, detail: "shimmer" },
};

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {}
  return fallback;
}

function writePref(key, val) {
  try { localStorage.setItem(key, val ? "1" : "0"); } catch {}
}

export function createAudioEngine({ mutedByUrl = false } = {}) {
  let ctx = null;
  let masterGain = null;
  let uiGain = null;
  let sfxGain = null;
  let ambMasterGain = null;
  let musicGain = null;
  let delayL = null;
  let delayR = null;
  let delaySend = null;

  let whiteBuf = null;
  let pinkBuf = null;
  let brownBuf = null;

  let soundEnabled = mutedByUrl ? false : readPref(STORAGE_SOUND, true);
  let musicEnabled = mutedByUrl ? false : readPref(STORAGE_MUSIC, true);
  let unlocked = false;
  let paused = false;
  let tabHidden = false;

  let curFxId = "splats";
  let curCategory = "stylization";
  let curStepIdx = 0;
  let strobeActive = false;

  let activeAmb = null;
  let detailTimer = null;
  let musicTimer = null;
  let musicStep = 0;
  let nextNoteTime = 0;

  let lastSplitTickPos = 0.5;
  let lastBlastMs = 0;
  let lastCrashMs = 0;
  let lastDragSfxMs = 0;

  const listeners = new Set();
  function notify() {
    const st = getState();
    for (const fn of listeners) fn(st);
  }

  function getState() {
    return { soundEnabled, musicEnabled, unlocked, paused };
  }

  function createNoiseBuffers(ac) {
    const len = ac.sampleRate * 3;
    const mk = fn => {
      const b = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = b.getChannelData(ch);
        fn(d);
      }
      return b;
    };
    whiteBuf = mk(d => {
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    });
    pinkBuf = mk(d => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    });
    brownBuf = mk(d => {
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    });
  }

  function initGraph() {
    if (ctx) return true;
    const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try {
      ctx = new AC();
    } catch {
      return false;
    }

    createNoiseBuffers(ctx);

    // Master glue compressor + safety limiter
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.0001;
    comp.connect(masterGain);
    masterGain.connect(ctx.destination);

    // Buses
    uiGain = ctx.createGain();
    uiGain.gain.value = 0.52;
    uiGain.connect(comp);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.68;
    sfxGain.connect(comp);

    ambMasterGain = ctx.createGain();
    ambMasterGain.gain.value = 0.55;
    ambMasterGain.connect(comp);

    musicGain = ctx.createGain();
    musicGain.gain.value = musicEnabled ? 0.34 : 0.0001;
    musicGain.connect(comp);

    // Warm stereo ping-pong ambience delay send (studio depth with tiny CPU cost)
    delaySend = ctx.createGain();
    delaySend.gain.value = 0.28;
    delayL = ctx.createDelay(1.0);
    delayR = ctx.createDelay(1.0);
    delayL.delayTime.value = 0.23;
    delayR.delayTime.value = 0.31;
    const fbL = ctx.createGain(); fbL.gain.value = 0.34;
    const fbR = ctx.createGain(); fbR.gain.value = 0.32;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 1900;
    const merger = ctx.createChannelMerger(2);

    delaySend.connect(damp);
    damp.connect(delayL);
    damp.connect(delayR);
    delayL.connect(fbL); fbL.connect(delayR);
    delayR.connect(fbR); fbR.connect(delayL);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    merger.connect(comp);

    return true;
  }

  function applyBusGains() {
    if (!ctx || !masterGain) return;
    const now = ctx.currentTime;
    const wantMaster = soundEnabled && !tabHidden ? 0.85 : 0.0001;
    masterGain.gain.setTargetAtTime(wantMaster, now, 0.06);

    const wantAmb = (soundEnabled && !paused && !tabHidden) ? 0.55 : 0.08;
    ambMasterGain.gain.setTargetAtTime(wantAmb, now, 0.14);

    const wantMusic = (soundEnabled && musicEnabled && !paused && !tabHidden) ? 0.34 : 0.0001;
    musicGain.gain.setTargetAtTime(wantMusic, now, 0.18);
  }

  function unlock() {
    if (!initGraph()) return false;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    if (!unlocked) {
      unlocked = true;
      applyBusGains();
      rebuildSceneAmbience();
      startMusicLoop();
      notify();
    } else {
      applyBusGains();
    }
    return true;
  }

  function canPlay() {
    return soundEnabled && !tabHidden && unlocked && ctx && ctx.state === "running";
  }

  // ---- LAYER 1: TACTILE UI SOUNDS ----

  function playTone(freq, dur, { type = "triangle", gain = 0.14, freqEnd = null, bus = null, delay = 0, wet = 0 } = {}) {
    if (!canPlay()) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + dur);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(g);
    g.connect(bus || uiGain);
    if (wet > 0 && delaySend) {
      const wg = ctx.createGain();
      wg.gain.value = wet;
      g.connect(wg);
      wg.connect(delaySend);
    }
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  function playNoiseBurst(dur, { buf = "white", filterType = "bandpass", freq = 1600, freqEnd = null, q = 2.0, gain = 0.14, bus = null, delay = 0, attack = 0.003 } = {}) {
    if (!canPlay()) return;
    const now = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = buf === "pink" ? pinkBuf : (buf === "brown" ? brownBuf : whiteBuf);
    src.loop = true;
    const offset = Math.random() * 1.8;

    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.setValueAtTime(freq, now);
    if (freqEnd !== null) flt.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), now + dur);
    flt.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(flt);
    flt.connect(g);
    g.connect(bus || uiGain);
    src.start(now, offset, dur + 0.03);
  }

  function playUi(kind, arg1, arg2) {
    if (!soundEnabled) return;
    unlock();
    if (!canPlay()) return;

    switch (kind) {
      case "click":
        // Crisp woody mechanical micro-switch
        playNoiseBurst(0.022, { freq: 2600, q: 2.2, gain: 0.11 });
        playTone(540, 0.045, { type: "triangle", gain: 0.12, freqEnd: 340 });
        break;

      case "step": {
        const idx = Math.max(0, Math.min(STEP_SCALE.length - 1, arg1 || 0));
        const hz = STEP_SCALE[idx];
        playNoiseBurst(0.018, { freq: 2400 + idx * 180, q: 2.6, gain: 0.08 });
        playTone(hz, 0.14, { type: "triangle", gain: 0.13, wet: 0.25 });
        playTone(hz * 2, 0.07, { type: "sine", gain: 0.045, delay: 0.015 });
        break;
      }

      case "effectSwitch": {
        const cat = arg1 || "rendering";
        const root = cat === "fluids" ? 349.23 : (cat === "physics" ? 329.63 : (cat === "lighting" ? 440.0 : 392.0));
        playNoiseBurst(0.16, { buf: "pink", freq: 450, freqEnd: 1950, q: 1.5, gain: 0.09, attack: 0.02 });
        playTone(root, 0.22, { type: "sine", gain: 0.10, wet: 0.35 });
        playTone(root * 1.5, 0.26, { type: "triangle", gain: 0.075, delay: 0.045, wet: 0.35 });
        break;
      }

      case "splitToggle": {
        const on = !!arg1;
        playNoiseBurst(0.028, { freq: on ? 2200 : 1400, q: 2.5, gain: 0.10 });
        playTone(on ? 440 : 620, 0.07, { type: "triangle", gain: 0.11, freqEnd: on ? 660 : 410 });
        playTone(on ? 660 : 410, 0.09, { type: "sine", gain: 0.09, delay: 0.04 });
        break;
      }

      case "splitDrag": {
        const pos = typeof arg1 === "number" ? arg1 : 0.5;
        if (Math.abs(pos - lastSplitTickPos) >= 0.045) {
          lastSplitTickPos = pos;
          playNoiseBurst(0.014, { freq: 1400 + pos * 1800, q: 4.5, gain: 0.065 });
          playTone(320 + pos * 420, 0.024, { type: "sine", gain: 0.04 });
        }
        break;
      }

      case "pause": {
        const isP = !!arg1;
        playTone(isP ? 520 : 340, 0.13, { type: "triangle", gain: 0.11, freqEnd: isP ? 260 : 540 });
        break;
      }

      case "reset":
        playTone(392, 0.12, { type: "sine", gain: 0.09, freqEnd: 587.33, wet: 0.3 });
        playTone(587.33, 0.18, { type: "triangle", gain: 0.08, delay: 0.05, freqEnd: 783.99, wet: 0.35 });
        break;

      case "catalog": {
        const open = !!arg1;
        playNoiseBurst(0.11, { buf: "pink", freq: open ? 600 : 1800, freqEnd: open ? 2000 : 550, q: 1.6, gain: 0.10, attack: 0.015 });
        playTone(open ? 380 : 520, 0.11, { type: "triangle", gain: 0.08, freqEnd: open ? 580 : 340 });
        break;
      }

      case "lang":
        playTone(620, 0.045, { type: "sine", gain: 0.09 });
        playTone(780, 0.055, { type: "sine", gain: 0.08, delay: 0.035 });
        break;

      case "action": {
        const id = String(arg1 || "");
        const active = !!arg2;
        if (id === "pillar" || id === "blast") {
          playCue({ type: "shellLaunch" });
        } else if (id === "push") {
          playCue({ type: "ragdollShove" });
        } else if (id === "rack" || id === "aperture") {
          playCue({ type: "lensFocus" });
        } else if (id === "strobe") {
          strobeActive = active;
          playCue({ type: "shutterClick" });
        } else if (id === "stamp") {
          playCue({ type: "polaroidStamp" });
        } else if (id === "gust" || id === "rip") {
          playCue({ type: "clothRip", rip: id === "rip" });
        } else if (id === "anvil" || id === "storm") {
          playCue({ type: "thunderRoll" });
        } else {
          // Sci-fi HUD inspector toggle (Velocity RGB, CoC, Stress View, Wireframe, Freeze Frustum, Mip Levels)
          playNoiseBurst(0.022, { freq: active ? 3200 : 1800, q: 3.5, gain: 0.09 });
          playTone(active ? 740 : 540, 0.09, { type: "sine", gain: 0.11, freqEnd: active ? 1110 : 390, wet: 0.25 });
        }
        break;
      }
    }
  }

  // ---- LAYER 2: LIVE SCENE INTERACTIVE FOLEY & EVENT CUES ----

  function duckMusic(amount = 0.55, hold = 0.35) {
    if (!ctx || !musicGain || !soundEnabled || !musicEnabled) return;
    const now = ctx.currentTime;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setTargetAtTime(0.34 * amount, now, 0.02);
    musicGain.gain.setTargetAtTime(0.34, now + hold, 0.32);
  }

  function playCue(detail) {
    if (!detail || !canPlay()) return;
    const nowMs = performance.now();

    switch (detail.type) {
      case "shellLaunch":
        // Incoming whistling cannonball/artillery shell
        playNoiseBurst(0.22, { buf: "pink", freq: 1550, freqEnd: 380, q: 3.2, gain: 0.20, bus: sfxGain, attack: 0.015 });
        playTone(460, 0.20, { type: "sine", gain: 0.07, freqEnd: 150, bus: sfxGain });
        break;

      case "blast": {
        // Debounce dual Split-Screen blasts so Left+Right never double-stack loudness!
        if (nowMs - lastBlastMs < 75) return;
        lastBlastMs = nowMs;
        const st = detail.stage ?? 7;
        const pwr = Math.min(1.35, detail.power || 1.0);
        duckMusic(0.42, 0.55);

        // Core seismic sub-bass punch
        playTone(108, 0.42, { type: "sine", gain: 0.40 * pwr, freqEnd: 30, bus: sfxGain });
        // Explosion broadband crack & rubble roar
        playNoiseBurst(st === 4 || st === 7 ? 0.92 : 0.52, {
          buf: "brown", filterType: "lowpass", freq: 1200, freqEnd: 160, q: 0.9, gain: 0.42 * pwr, bus: sfxGain, attack: 0.004
        });
        playNoiseBurst(0.14, { buf: "white", filterType: "bandpass", freq: 1600, q: 1.1, gain: 0.24 * pwr, bus: sfxGain });

        // Era-specific authentic foley signature!
        if (st === 0) {
          // 1998 Half-Life crunchy retro square pop
          playTone(190, 0.14, { type: "square", gain: 0.12, freqEnd: 52, bus: sfxGain });
        } else if (st === 3) {
          // 2008 Force Unleashed DMM steel girder metallic clang & plastic bend groan
          playTone(218, 0.55, { type: "sawtooth", gain: 0.08, freqEnd: 186, bus: sfxGain, wet: 0.35 });
          playTone(347, 0.48, { type: "triangle", gain: 0.10, freqEnd: 312, bus: sfxGain, wet: 0.35 });
        } else if (st === 4 || st === 7) {
          // 2009 Guerrilla / 2023 Finals: structural stress creak + deep cascading masonry avalanche!
          playTone(135, 0.55, { type: "sawtooth", gain: 0.06, freqEnd: 88, delay: 0.12, bus: sfxGain });
          for (let k = 0; k < 6; k++) {
            const dly = 0.22 + k * 0.11 + Math.random() * 0.06;
            playNoiseBurst(0.06, { buf: "white", freq: 420 + Math.random() * 750, q: 2.2, gain: 0.12 * pwr, delay: dly, bus: sfxGain });
          }
        } else if (st === 5) {
          // 2013-19 Voronoi sharp brittle concrete & glass crack burst
          for (let k = 0; k < 5; k++) {
            playNoiseBurst(0.045, { buf: "white", filterType: "highpass", freq: 2400 + k * 450, q: 1.8, gain: 0.14, delay: k * 0.032, bus: sfxGain });
          }
        } else if (st === 6) {
          // 2020-22 Teardown rapid tactile micro-voxel crunch shower!
          for (let k = 0; k < 9; k++) {
            const dly = 0.04 + k * 0.055 + Math.random() * 0.03;
            playNoiseBurst(0.032, { buf: "white", freq: 900 + Math.random() * 1800, q: 3.2, gain: 0.13, delay: dly, bus: sfxGain });
            playTone(420 + Math.random() * 520, 0.028, { type: "triangle", gain: 0.055, delay: dly, bus: sfxGain });
          }
        } else {
          // 2001 CSG / 2003 Havok tumbling stone chunks
          for (let k = 0; k < 4; k++) {
            playNoiseBurst(0.055, { buf: "pink", freq: 500 + Math.random() * 480, q: 2.0, gain: 0.12, delay: 0.18 + k * 0.12, bus: sfxGain });
          }
        }
        break;
      }

      case "rubbleCrash": {
        if (nowMs - lastCrashMs < 130) return;
        lastCrashMs = nowMs;
        playTone(68, 0.22, { type: "sine", gain: 0.22, freqEnd: 28, bus: sfxGain });
        playNoiseBurst(0.28, { buf: "brown", filterType: "lowpass", freq: 720, freqEnd: 150, q: 1.0, gain: 0.24, bus: sfxGain });
        break;
      }

      case "waterSplash":
        // Juicy resonant droplet plop + soft ripple shimmer
        playTone(320, 0.14, { type: "sine", gain: 0.16, freqEnd: 740, bus: sfxGain, wet: 0.35 });
        playTone(540, 0.10, { type: "sine", gain: 0.09, freqEnd: 1120, delay: 0.045, bus: sfxGain, wet: 0.35 });
        playNoiseBurst(0.18, { buf: "pink", freq: 1100, freqEnd: 480, q: 1.4, gain: 0.12, bus: sfxGain });
        break;

      case "lensFocus":
        // Authentic DSLR autofocus motor whir + mechanical aperture iris click
        playNoiseBurst(0.018, { freq: 3400, q: 4.0, gain: 0.14, bus: sfxGain });
        playTone(280, 0.14, { type: "triangle", gain: 0.055, freqEnd: 430, delay: 0.01, bus: sfxGain });
        playNoiseBurst(0.016, { freq: 2900, q: 4.5, gain: 0.12, delay: 0.13, bus: sfxGain });
        break;

      case "shutterClick":
        playNoiseBurst(0.024, { freq: 2800, q: 2.5, gain: 0.18, bus: sfxGain });
        playTone(180, 0.032, { type: "triangle", gain: 0.14, freqEnd: 95, bus: sfxGain });
        break;

      case "speedBurst":
        // Motion blur turbine whoosh
        playNoiseBurst(0.42, { buf: "pink", freq: 260, freqEnd: 1850, q: 2.2, gain: 0.22, bus: sfxGain, attack: 0.04 });
        playTone(150, 0.40, { type: "sawtooth", gain: 0.06, freqEnd: 460, bus: sfxGain });
        break;

      case "ragdollShove":
        playTone(145, 0.18, { type: "sine", gain: 0.26, freqEnd: 42, bus: sfxGain });
        playNoiseBurst(0.12, { buf: "pink", freq: 620, freqEnd: 180, q: 1.2, gain: 0.20, bus: sfxGain });
        break;

      case "portalShot":
        playTone(260, 0.28, { type: "sine", gain: 0.13, freqEnd: 780, bus: sfxGain, wet: 0.45 });
        playTone(390, 0.26, { type: "triangle", gain: 0.08, freqEnd: 195, delay: 0.02, bus: sfxGain, wet: 0.45 });
        playNoiseBurst(0.24, { buf: "pink", freq: 1400, freqEnd: 420, q: 3.5, gain: 0.14, bus: sfxGain });
        break;

      case "polaroidStamp":
        // Crisp camera shutter snap + iconic motor film-eject whir!
        playNoiseBurst(0.025, { freq: 3100, q: 2.0, gain: 0.22, bus: sfxGain });
        playTone(170, 0.04, { type: "triangle", gain: 0.16, freqEnd: 85, bus: sfxGain });
        playNoiseBurst(0.32, { buf: "white", freq: 1100, freqEnd: 1450, q: 5.0, gain: 0.09, delay: 0.06, bus: sfxGain });
        playTone(210, 0.30, { type: "sawtooth", gain: 0.04, freqEnd: 245, delay: 0.06, bus: sfxGain });
        break;

      case "clothRip":
        if (detail.rip) {
          playNoiseBurst(0.28, { buf: "white", freq: 2200, freqEnd: 950, q: 1.8, gain: 0.22, bus: sfxGain });
        } else {
          playNoiseBurst(0.34, { buf: "pink", freq: 380, freqEnd: 880, q: 1.6, gain: 0.20, bus: sfxGain, attack: 0.04 });
        }
        break;

      case "furPet":
        if (nowMs - lastDragSfxMs < 95) return;
        lastDragSfxMs = nowMs;
        playNoiseBurst(0.14, { buf: "pink", freq: 920, freqEnd: 540, q: 1.2, gain: 0.11, bus: sfxGain, attack: 0.02 });
        break;

      case "grassGust":
        playNoiseBurst(0.45, { buf: "pink", freq: 1650, freqEnd: 720, q: 1.8, gain: 0.15, bus: sfxGain, attack: 0.05 });
        break;

      case "lightChime":
        playTone(659.25, 0.24, { type: "sine", gain: 0.09, bus: sfxGain, wet: 0.45 });
        playTone(987.77, 0.30, { type: "sine", gain: 0.06, delay: 0.035, bus: sfxGain, wet: 0.45 });
        break;

      case "thunderRoll":
        playTone(62, 0.85, { type: "sine", gain: 0.24, freqEnd: 28, bus: sfxGain });
        playNoiseBurst(1.1, { buf: "brown", filterType: "lowpass", freq: 320, freqEnd: 95, q: 0.8, gain: 0.28, bus: sfxGain, attack: 0.08 });
        break;

      case "dialTick":
        playNoiseBurst(0.015, { freq: 3000, q: 4.0, gain: 0.10, bus: sfxGain });
        playTone(460 + (detail.norm || 0.5) * 440, 0.04, { type: "triangle", gain: 0.08, bus: sfxGain });
        break;
    }
  }

  function playCanvasClick(fxId, stepIdx, ndcX) {
    if (!soundEnabled) return;
    unlock();
    if (!canPlay()) return;
    switch (fxId) {
      case "water":       playCue({ type: "waterSplash" }); break;
      case "dof":         playCue({ type: "lensFocus" }); break;
      case "motionblur":  playCue({ type: "speedBurst" }); break;
      case "destruction": /* handled directly by shared.js fireShell/applyBlast! */ break;
      case "animation":   playCue({ type: "ragdollShove" }); break;
      case "cloth":       playCue({ type: "clothRip", rip: stepIdx === 7 }); break;
      case "fur":         playCue({ type: "furPet" }); break;
      case "grass":       playCue({ type: "grassGust" }); break;
      case "portals":     playCue({ type: stepIdx === 7 ? "polaroidStamp" : "portalShot" }); break;
      case "tonemapping":
      case "dithering":
      case "terrain":     playCue({ type: "dialTick", norm: (ndcX + 1) * 0.5 }); break;
      case "glass":
      case "shadows":
      case "clouds":
      case "pathtracing":
      case "gi":
      case "reflections":
      case "fog":
      case "skin":
      case "surface":
      case "toon":
      case "ascii":
      case "hd2d":        playCue({ type: "lightChime" }); break;
      default:            playUi("click"); break;
    }
  }

  // ---- LAYER 3: BESPOKE CONTINUOUS SCENE AMBIENT SOUNDSCAPES ----

  function stopAmbience() {
    if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    if (!activeAmb || !ctx) return;
    const old = activeAmb;
    activeAmb = null;
    const now = ctx.currentTime;
    try {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setTargetAtTime(0.0001, now, 0.09);
      setTimeout(() => {
        for (const n of old.nodes) {
          try { if (n.stop) n.stop(); } catch {}
          try { n.disconnect(); } catch {}
        }
      }, 420);
    } catch {}
  }

  function rebuildSceneAmbience() {
    if (!ctx || !unlocked) return;
    stopAmbience();

    const prof = SCENE_AMBIENCE[curFxId] || SCENE_AMBIENCE.studio;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.setTargetAtTime(prof.gain, now, 0.28);
    out.connect(ambMasterGain);

    const nodes = [out];

    // Primary textured air / noise bed
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = (prof.kind === "fire" || prof.kind === "outdoor" || prof.kind === "studio") ? brownBuf : pinkBuf;
    nSrc.loop = true;

    const flt = ctx.createBiquadFilter();
    flt.type = (prof.kind === "fire" || prof.kind === "studio") ? "lowpass" : "bandpass";
    flt.frequency.value = prof.baseFreq;
    flt.Q.value = prof.q;

    // Gentle organic LFO breathing on the ambient filter
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = prof.kind === "rotor" ? 10.5 : (prof.kind === "water" ? 0.18 : (prof.kind === "cloth" ? 2.1 : 0.24));
    lfoGain.gain.value = prof.kind === "rotor" ? 65 : (prof.kind === "water" ? 220 : (prof.kind === "wind" ? 260 : 85));
    lfo.connect(lfoGain);
    lfoGain.connect(flt.frequency);
    lfo.start(now);

    nSrc.connect(flt);
    flt.connect(out);
    nSrc.start(now, Math.random() * 1.5);
    nodes.push(nSrc, flt, lfo, lfoGain);

    // Harmonic tone drone layer for architectural / sci-fi / optical spaces
    if (prof.kind === "cathedral" || prof.kind === "crystal" || prof.kind === "gallery" || prof.kind === "portal" || prof.kind === "neon" || prof.kind === "rotor") {
      const ratios = prof.kind === "cathedral" ? [1, 1.5]
        : (prof.kind === "portal" ? [1, 2.006]
        : (prof.kind === "crystal" ? [1, 1.5, 2.0]
        : (prof.kind === "neon" ? [1, 2]
        : [1, 1.498])));
      const dg = ctx.createGain();
      dg.gain.value = prof.kind === "neon" ? 0.14 : (prof.kind === "rotor" ? 0.22 : 0.18);
      const dlp = ctx.createBiquadFilter();
      dlp.type = "lowpass";
      dlp.frequency.value = prof.kind === "crystal" ? 1600 : (prof.kind === "neon" ? 420 : 680);
      dg.connect(dlp);
      dlp.connect(out);
      if (delaySend && prof.kind !== "neon" && prof.kind !== "rotor") dlp.connect(delaySend);
      nodes.push(dg, dlp);

      for (const r of ratios) {
        const o = ctx.createOscillator();
        o.type = prof.kind === "neon" || prof.kind === "rotor" ? "sawtooth" : "sine";
        o.frequency.value = prof.baseFreq * r;
        o.connect(dg);
        o.start(now);
        nodes.push(o);
      }
    }

    activeAmb = { gain: out, nodes, kind: prof.kind };

    // Stochastic micro-details (campfire crackles, water drops, meadow chirps, 24fps film clatter)
    detailTimer = setInterval(() => {
      if (!canPlay() || paused) return;
      if (prof.detail === "crackle" || prof.detail === "torch") {
        if (Math.random() < (prof.detail === "crackle" ? 0.72 : 0.42)) {
          playNoiseBurst(0.018 + Math.random() * 0.025, {
            buf: "white", freq: 1800 + Math.random() * 2800, q: 3.5,
            gain: 0.04 + Math.random() * 0.06, bus: ambMasterGain,
          });
        }
      } else if (prof.detail === "droplet" || prof.detail === "waterfall") {
        if (Math.random() < 0.26) {
          const f = 720 + Math.random() * 680;
          playTone(f, 0.09, { type: "sine", gain: 0.032, freqEnd: f * 1.48, bus: ambMasterGain, wet: 0.35 });
        }
      } else if (prof.detail === "bird") {
        if (Math.random() < 0.12) {
          const f = 2200 + Math.random() * 900;
          playTone(f, 0.065, { type: "sine", gain: 0.022, freqEnd: f * 1.24, bus: ambMasterGain, wet: 0.3 });
          playTone(f * 1.15, 0.07, { type: "sine", gain: 0.018, freqEnd: f * 0.95, delay: 0.085, bus: ambMasterGain, wet: 0.3 });
        }
      } else if (prof.detail === "rotor" && strobeActive) {
        // Subtle 24 FPS cinema projector gate clatter when Strobe toggle is ON
        playNoiseBurst(0.014, { freq: 2400, q: 4.5, gain: 0.055, bus: ambMasterGain });
      }
    }, 240);
  }

  // ---- LAYER 4: ADAPTIVE PROCEDURAL STUDIO SOUNDTRACK ----

  function scheduleMusicNote(time) {
    const theme = MUSIC_THEMES[curCategory] || MUSIC_THEMES.rendering;
    const barIdx = Math.floor(musicStep / 8) % theme.chords.length;
    const beatInBar = musicStep % 8;
    const chord = theme.chords[barIdx];

    // Warm pad chord on beat 0 of every bar (4-second lush harmonic wash)
    if (beatInBar === 0) {
      const padDur = theme.tempo * 8.2;
      for (let i = 0; i < 4; i++) {
        const o = ctx.createOscillator();
        const flt = ctx.createBiquadFilter();
        const g = ctx.createGain();
        o.type = i === 0 ? "triangle" : "sine";
        o.frequency.setValueAtTime(chord[i] * (i === 0 ? 0.5 : 1.0), time);
        flt.type = "lowpass";
        flt.frequency.setValueAtTime(theme.cutoff * 0.72, time);

        const amp = i === 0 ? 0.10 : 0.055;
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(amp, time + 0.65);
        g.gain.setTargetAtTime(0.0001, time + padDur - 0.85, 0.35);

        o.connect(flt);
        flt.connect(g);
        g.connect(musicGain);
        if (delaySend && i > 0) g.connect(delaySend);
        o.start(time);
        o.stop(time + padDur + 0.4);
      }
    }

    // Gentle melodic Rhodes/marimba arpeggio pluck
    const noteHz = chord[theme.arp[beatInBar] % chord.length] * (beatInBar === 6 ? 2.0 : 1.0);
    const o = ctx.createOscillator();
    const flt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = theme.tone;
    // Slight subtle retro shimmer on early 1985-1996 eras!
    o.frequency.setValueAtTime(noteHz, time);
    flt.type = "lowpass";
    flt.frequency.setValueAtTime(theme.cutoff, time);
    flt.frequency.exponentialRampToValueAtTime(420, time + 0.65);

    const accent = beatInBar === 0 ? 0.088 : (beatInBar % 2 === 0 ? 0.058 : 0.036);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(accent, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.72);

    o.connect(flt);
    flt.connect(g);
    g.connect(musicGain);
    if (delaySend) {
      const wg = ctx.createGain();
      wg.gain.value = 0.38;
      g.connect(wg);
      wg.connect(delaySend);
    }
    o.start(time);
    o.stop(time + 0.78);

    musicStep = (musicStep + 1) % (theme.chords.length * 8);
  }

  function startMusicLoop() {
    if (musicTimer || !ctx) return;
    nextNoteTime = ctx.currentTime + 0.12;
    musicTimer = setInterval(() => {
      if (!ctx || !unlocked || !soundEnabled || !musicEnabled || paused || tabHidden || ctx.state !== "running") {
        if (ctx) nextNoteTime = ctx.currentTime + 0.12;
        return;
      }
      const theme = MUSIC_THEMES[curCategory] || MUSIC_THEMES.rendering;
      while (nextNoteTime < ctx.currentTime + 0.24) {
        scheduleMusicNote(nextNoteTime);
        nextNoteTime += theme.tempo;
      }
    }, 90);
  }

  // Listen for live effect-emitted SFX events (e.g., Destruction blasts & collapses!)
  if (typeof window !== "undefined") {
    window.addEventListener("fxlab:sfx", ev => {
      if (ev?.detail) playCue(ev.detail);
    });
    document.addEventListener("visibilitychange", () => {
      tabHidden = document.hidden;
      applyBusGains();
    });
    // Unlock seamlessly on first user interaction anywhere in FX Lab
    const onFirstGesture = () => {
      if (soundEnabled && !unlocked) unlock();
      window.removeEventListener("pointerdown", onFirstGesture, true);
      window.removeEventListener("keydown", onFirstGesture, true);
    };
    window.addEventListener("pointerdown", onFirstGesture, true);
    window.addEventListener("keydown", onFirstGesture, true);
  }

  return {
    getState,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    unlock,
    setScene(fxId, category, stepIdx = 0) {
      const changed = fxId !== curFxId;
      curFxId = fxId;
      curCategory = category || "rendering";
      curStepIdx = stepIdx;
      strobeActive = false;
      if (changed && unlocked) rebuildSceneAmbience();
    },
    setStep(stepIdx) {
      curStepIdx = stepIdx;
    },
    setPaused(isPaused) {
      paused = !!isPaused;
      applyBusGains();
      notify();
    },
    toggleSound() {
      soundEnabled = !soundEnabled;
      writePref(STORAGE_SOUND, soundEnabled);
      if (soundEnabled) {
        unlock();
        setTimeout(() => playUi("click"), 15);
      } else {
        applyBusGains();
      }
      notify();
      return soundEnabled;
    },
    toggleMusic() {
      musicEnabled = !musicEnabled;
      writePref(STORAGE_MUSIC, musicEnabled);
      if (musicEnabled && !soundEnabled) {
        soundEnabled = true;
        writePref(STORAGE_SOUND, true);
      }
      if (soundEnabled) unlock();
      applyBusGains();
      if (soundEnabled) playUi("click");
      notify();
      return musicEnabled;
    },
    playUi,
    playCue,
    playCanvasClick,
  };
}
