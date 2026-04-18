/**
 * Jarvis IA — Sprint 3: ElevenLabs TTS via n8n webhook
 * STT: Web Speech API (SpeechRecognition)
 * TTS: ElevenLabs (George) via n8n webhook, with Web Speech fallback
 */

(function () {
  'use strict';

  // --- Configuration ---
  var CONFIG = {
    PARTICLE_COUNT: 180,
    RING_COUNT: 3,
    CORE_RADIUS: 80,
    RING_GAP: 35,
    BASE_SPEED: 0.0008,
    AUDIO_SENSITIVITY: 2.5,
    GLOW_INTENSITY: 0.6,
    IDLE_PULSE_SPEED: 0.002,
    IDLE_PULSE_AMOUNT: 0.15,
    COLOR_PRIMARY: { r: 0, g: 212, b: 255 },    // cyan
    COLOR_SECONDARY: { r: 0, g: 255, b: 204 },  // green-cyan
    COLOR_ACCENT: { r: 100, g: 140, b: 255 },    // blue
    FFT_SIZE: 256,
    SMOOTHING: 0.8,
    SPEECH_LANG: 'pt-BR',
    SILENCE_TIMEOUT_MS: 1500,
    TTS_RATE: 0.98,
    TTS_PITCH: 1.0,
    TTS_VOLUME: 1.0,
    VOICE_STORAGE_KEY: 'jarvis.voice.uri',
    TTS_PROVIDER_STORAGE_KEY: 'jarvis.tts.provider',
    ELEVENLABS_WEBHOOK_URL: 'https://n8n.eltonmiranda.com.br/webhook/jarvis-tts',
    ELEVENLABS_WEBHOOK_SECRET: '5997a692b7393dc4f47db5de024d1406a859a876cb6e291affc396f24873e824',
    ELEVENLABS_TIMEOUT_MS: 15000,
    JARVIS_CHAT_URL: 'https://n8n.eltonmiranda.com.br/webhook/jarvis-chat',
    JARVIS_CHAT_TIMEOUT_MS: 20000,
    STT_RESUME_DELAY_MS: 500,
    ECHO_SIMILARITY_THRESHOLD: 0.5,
    WORD_FADE_IN_MS: 150,
    WORD_FADE_OUT_MS: 60,
    WORD_FADE_TRANSITION_MS: 600,
    WORD_TARGET_OPACITY: 0.5,
  };

  // --- State ---
  var canvas, ctx;
  var centerX, centerY;
  var particles = [];
  var rings = [];
  var audioCtx = null;
  var analyser = null;
  var dataArray = null;
  var micStream = null;
  var isListening = false;
  var audioLevel = 0;
  var smoothedLevel = 0;
  var time = 0;
  var dpr = 1;

  // Speech state
  var recognition = null;
  var sttSupported = false;
  var ttsSupported = false;
  var silenceTimer = null;
  var finalTranscriptBuffer = '';
  var isSpeaking = false;
  var ttsLevel = 0;
  var ptVoice = null;
  var availableVoices = [];
  var userPickedVoiceURI = null;
  var ttsProvider = 'elevenlabs'; // 'elevenlabs' | 'webspeech'
  var currentAudio = null;
  var currentAudioURL = null;
  var ttsRequestSeq = 0;
  var chatRequestSeq = 0;
  var isProcessing = false;
  var lastJarvisReply = '';
  var sttResumeTimer = null;

  // DOM elements
  var micBtn, statusText, volumeMeter, volumeBars;
  var responseContainer;
  var voiceSelect, providerToggle;
  var responseSeq = 0;

  // --- Initialization ---
  function init() {
    canvas = document.getElementById('jarvis-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    micBtn = document.getElementById('mic-btn');
    statusText = document.getElementById('status-text');
    volumeMeter = document.getElementById('volume-meter');
    responseContainer = document.getElementById('response-container');
    voiceSelect = document.getElementById('voice-select');
    providerToggle = document.getElementById('provider-toggle');

    // Restore voice preference
    try {
      userPickedVoiceURI = localStorage.getItem(CONFIG.VOICE_STORAGE_KEY);
      var savedProvider = localStorage.getItem(CONFIG.TTS_PROVIDER_STORAGE_KEY);
      if (savedProvider === 'webspeech' || savedProvider === 'elevenlabs') {
        ttsProvider = savedProvider;
      }
    } catch (err) {
      userPickedVoiceURI = null;
    }

    setupProviderToggle();

    // Create volume bars
    createVolumeBars(20);

    // Handle high-DPI displays
    dpr = window.devicePixelRatio || 1;
    resize();
    window.addEventListener('resize', resize);

    // Create particles and rings
    createParticles();
    createRings();

    // Speech APIs
    setupSpeechRecognition();
    setupSpeechSynthesis();

    // Mic button handler
    micBtn.addEventListener('click', toggleMicrophone);

    // Start animation
    requestAnimationFrame(animate);
  }

  function resize() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    centerX = w / 2;
    centerY = h / 2;

    // Scale core radius based on viewport
    var minDim = Math.min(w, h);
    CONFIG.CORE_RADIUS = Math.max(50, minDim * 0.1);
    CONFIG.RING_GAP = Math.max(20, minDim * 0.04);
  }

  // --- Volume meter ---
  function createVolumeBars(count) {
    volumeBars = [];
    volumeMeter.innerHTML = '';
    for (var i = 0; i < count; i++) {
      var bar = document.createElement('div');
      bar.className = 'volume-bar';
      volumeMeter.appendChild(bar);
      volumeBars.push(bar);
    }
  }

  function updateVolumeMeter(level) {
    var litCount = Math.floor(level * volumeBars.length);
    for (var i = 0; i < volumeBars.length; i++) {
      if (i < litCount) {
        volumeBars[i].classList.add('lit');
        if (i > volumeBars.length * 0.75) {
          volumeBars[i].classList.add('high');
        } else {
          volumeBars[i].classList.remove('high');
        }
      } else {
        volumeBars[i].classList.remove('lit');
        volumeBars[i].classList.remove('high');
      }
    }
  }

  // --- Audio ---
  function toggleMicrophone() {
    if (isListening) {
      stopMicrophone();
    } else {
      startMicrophone();
    }
  }

  function startMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusText.textContent = 'MICROPHONE NOT SUPPORTED';
      return;
    }

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
      .then(function (stream) {
        micStream = stream;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = CONFIG.FFT_SIZE;
        analyser.smoothingTimeConstant = CONFIG.SMOOTHING;

        var source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        dataArray = new Uint8Array(analyser.frequencyBinCount);

        isListening = true;
        micBtn.classList.add('active');
        setStatus('OUVINDO', true);
        volumeMeter.classList.add('visible');

        // Start STT alongside the audio stream
        startRecognition();
      })
      .catch(function (err) {
        console.error('Microphone error:', err);
        setStatus('MIC NEGADO', false);
      });
  }

  function stopMicrophone() {
    stopRecognition();
    cancelTTS();
    lastJarvisReply = '';

    if (micStream) {
      micStream.getTracks().forEach(function (track) { track.stop(); });
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
      analyser = null;
      dataArray = null;
    }
    isListening = false;
    audioLevel = 0;
    smoothedLevel = 0;
    micBtn.classList.remove('active');
    setStatus('ESPERA', false);
    volumeMeter.classList.remove('visible');
    updateVolumeMeter(0);
    clearResponse();
  }

  function setStatus(text, active) {
    if (!statusText) return;
    statusText.textContent = text;
    if (active) {
      statusText.classList.add('active');
    } else {
      statusText.classList.remove('active');
    }
  }

  function getAudioLevel() {
    if (!analyser || !dataArray) return 0;

    analyser.getByteFrequencyData(dataArray);

    var sum = 0;
    var len = dataArray.length;
    for (var i = 0; i < len; i++) {
      sum += dataArray[i];
    }
    var avg = sum / len / 255; // normalize to 0-1
    return Math.min(1, avg * CONFIG.AUDIO_SENSITIVITY);
  }

  // --- Speech Recognition (STT) ---
  function setupSpeechRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      sttSupported = false;
      console.warn('SpeechRecognition not supported in this browser.');
      return;
    }
    sttSupported = true;
    recognition = new SR();
    recognition.lang = CONFIG.SPEECH_LANG;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = handleRecognitionResult;
    recognition.onerror = handleRecognitionError;
    recognition.onend = handleRecognitionEnd;
  }

  function startRecognition() {
    if (!sttSupported || !recognition) {
      setStatus('STT NAO SUPORTADO', false);
      return;
    }
    finalTranscriptBuffer = '';
    try {
      recognition.start();
    } catch (err) {
      // already started — safe to ignore
      console.warn('recognition.start():', err && err.message);
    }
  }

  function stopRecognition() {
    if (!recognition) return;
    // abort() discards any buffered audio; safer than stop() which may still
    // fire a final onresult with whatever was captured so far.
    try { recognition.abort(); } catch (err) { /* noop */ }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function pauseRecognitionForTTS() {
    if (sttResumeTimer) {
      clearTimeout(sttResumeTimer);
      sttResumeTimer = null;
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    finalTranscriptBuffer = '';
    if (recognition) {
      try { recognition.abort(); } catch (err) { /* noop */ }
    }
  }

  function scheduleResumeRecognition() {
    if (sttResumeTimer) clearTimeout(sttResumeTimer);
    sttResumeTimer = setTimeout(function () {
      sttResumeTimer = null;
      if (!isListening || isSpeaking || isProcessing) return;
      if (!recognition) return;
      finalTranscriptBuffer = '';
      try { recognition.start(); } catch (err) { /* already started — ignore */ }
    }, CONFIG.STT_RESUME_DELAY_MS);
  }

  function handleRecognitionResult(event) {
    // Anti-echo guard: drop anything the mic captured while Jarvis was
    // speaking or the app was processing. These events can arrive even after
    // abort() on some browsers.
    if (isSpeaking || isProcessing) {
      return;
    }

    var interim = '';
    var finalChunk = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var res = event.results[i];
      var transcript = res[0].transcript;
      if (res.isFinal) {
        finalChunk += transcript;
      } else {
        interim += transcript;
      }
    }

    if (interim) {
      resetSilenceTimer();
    }

    if (finalChunk) {
      finalTranscriptBuffer = (finalTranscriptBuffer + ' ' + finalChunk).trim();
      resetSilenceTimer();
    }
  }

  function handleRecognitionError(event) {
    var err = event && event.error;
    if (err === 'no-speech' || err === 'aborted') {
      // benign — ignore
      return;
    }
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      setStatus('PERMISSAO STT NEGADA', false);
      return;
    }
    console.warn('STT error:', err);
  }

  function handleRecognitionEnd() {
    // Do NOT auto-restart while Jarvis is speaking or we're still processing
    // a previous sentence. That was the cause of the feedback loop: onend
    // would fire after stop() during PROCESSING and silently re-open the mic,
    // which then captured Jarvis's own voice playback.
    if (!isListening || isSpeaking || isProcessing) return;
    try {
      recognition.start();
    } catch (err) {
      // ignore double-start
    }
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(function () {
      var sentence = finalTranscriptBuffer.trim();
      if (sentence.length > 0) {
        finalTranscriptBuffer = '';
        handleUserSentence(sentence);
      }
    }, CONFIG.SILENCE_TIMEOUT_MS);
  }

  function normalizeText(s) {
    if (!s) return '';
    var str = String(s).toLowerCase();
    if (typeof str.normalize === 'function') {
      str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents
    }
    return str.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function jaccardSimilarity(a, b) {
    var wA = normalizeText(a).split(' ').filter(Boolean);
    var wB = normalizeText(b).split(' ').filter(Boolean);
    if (!wA.length || !wB.length) return 0;
    var setA = {};
    for (var i = 0; i < wA.length; i++) setA[wA[i]] = 1;
    var inter = 0;
    var union = {};
    for (var k in setA) union[k] = 1;
    for (var j = 0; j < wB.length; j++) {
      if (setA[wB[j]]) inter++;
      union[wB[j]] = 1;
    }
    var unionSize = 0;
    for (var u in union) unionSize++;
    return unionSize ? inter / unionSize : 0;
  }

  function handleUserSentence(sentence) {
    // Echo guard: if the STT picked up something very similar to the last
    // Jarvis reply, assume it's mic feedback (TTS bleed-through) and drop it.
    if (lastJarvisReply) {
      var sim = jaccardSimilarity(sentence, lastJarvisReply);
      if (sim >= CONFIG.ECHO_SIMILARITY_THRESHOLD) {
        console.log('[Jarvis] echo detected (sim=' + sim.toFixed(2) + '), ignoring:', sentence);
        return;
      }
    }

    var seq = ++chatRequestSeq;
    isProcessing = true;
    setStatus('PROCESSANDO', true);

    // Hard-pause STT while we wait for the reply. abort() discards any
    // audio still in the recognizer's buffer, and we reset the transcript
    // buffer so a stale interim result can't re-trigger handleUserSentence.
    pauseRecognitionForTTS();

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = setTimeout(function () {
      if (controller) controller.abort();
    }, CONFIG.JARVIS_CHAT_TIMEOUT_MS);

    var fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': CONFIG.ELEVENLABS_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ text: sentence }),
    };
    if (controller) fetchOpts.signal = controller.signal;

    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

    fetch(CONFIG.JARVIS_CHAT_URL, fetchOpts)
      .then(function (res) {
        if (!res.ok) {
          throw new Error('jarvis-chat HTTP ' + res.status);
        }
        return res.text().then(function (raw) {
          try {
            return JSON.parse(raw);
          } catch (err) {
            throw new Error('Invalid JSON from jarvis-chat: ' + raw.slice(0, 120));
          }
        });
      })
      .then(function (data) {
        clearTimeout(timeoutId);
        if (seq !== chatRequestSeq) {
          // Superseded by newer sentence
          return;
        }
        var t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        console.log('[Jarvis] chat latency:', Math.round(t1 - t0) + 'ms');

        var reply = (data && typeof data.response === 'string' && data.response.trim())
          ? data.response.trim()
          : 'Desculpe, nao entendi.';
        lastJarvisReply = reply;
        isProcessing = false;
        speak(reply);
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        if (seq !== chatRequestSeq) return;
        var errReply = 'Desculpe, falha na conexao.';
        lastJarvisReply = errReply;
        isProcessing = false;
        console.error('[Jarvis] chat error:', err && err.message);
        speak(errReply);
      });
  }

  // --- Speech Synthesis (TTS) ---
  function setupSpeechSynthesis() {
    if (!('speechSynthesis' in window)) {
      ttsSupported = false;
      console.warn('speechSynthesis not supported in this browser.');
      return;
    }
    ttsSupported = true;
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  function loadVoices() {
    var voices = window.speechSynthesis.getVoices();
    if (!voices || !voices.length) return;
    availableVoices = voices.slice();

    // Debug log of all voices in the OS (for tuning)
    try {
      console.log('[Jarvis] Vozes disponiveis no SO (' + voices.length + '):');
      console.table(voices.map(function (v) {
        return {
          name: v.name,
          lang: v.lang,
          local: v.localService,
          default: v.default,
          uri: v.voiceURI,
        };
      }));
    } catch (err) { /* console.table may not exist */ }

    // Score each voice; highest wins
    var ptVoices = voices.filter(function (v) {
      return v.lang && v.lang.toLowerCase().indexOf('pt') === 0;
    });
    var pool = ptVoices.length ? ptVoices : voices;

    var best = pickBestVoice(pool);
    ptVoice = best;

    // If user already picked a voice, honor it
    if (userPickedVoiceURI) {
      var saved = voices.find(function (v) { return v.voiceURI === userPickedVoiceURI; });
      if (saved) ptVoice = saved;
    }

    populateVoiceSelect(ptVoices.length ? ptVoices : voices);

    if (ptVoice) {
      console.log('[Jarvis] Voz selecionada:', ptVoice.name, '(' + ptVoice.lang + ')');
    } else {
      console.warn('[Jarvis] Nenhuma voz pt encontrada — usando voz default do sistema.');
    }
  }

  function pickBestVoice(voices) {
    if (!voices || !voices.length) return null;
    var scored = voices.map(function (v) {
      return { voice: v, score: scoreVoice(v) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored[0].voice;
  }

  function scoreVoice(v) {
    var name = (v.name || '').toLowerCase();
    var lang = (v.lang || '').toLowerCase();
    var score = 0;

    // Language preference: pt-BR strongly preferred over pt-PT
    if (lang === 'pt-br') score += 100;
    else if (lang.indexOf('pt') === 0) score += 40;

    // Neural / Online voices are higher quality (Microsoft Neural, Google, Azure)
    if (name.indexOf('neural') !== -1) score += 60;
    if (name.indexOf('online') !== -1) score += 50;
    if (name.indexOf('natural') !== -1) score += 50;
    if (name.indexOf('wavenet') !== -1) score += 55;
    if (name.indexOf('studio') !== -1) score += 45;

    // Cloud / non-local often = higher quality
    if (v.localService === false) score += 25;

    // Known Windows pt-BR voice names (Maria > Francisca > Daniel)
    if (name.indexOf('maria') !== -1) score += 30;
    if (name.indexOf('francisca') !== -1) score += 28;
    if (name.indexOf('daniel') !== -1) score += 22;
    if (name.indexOf('thalita') !== -1) score += 26;
    if (name.indexOf('antonio') !== -1) score += 20;

    // Google pt-BR (Chrome built-in, decent quality)
    if (name.indexOf('google') !== -1 && lang === 'pt-br') score += 35;

    // Microsoft brand boost (usually the only local pt-BR on Windows)
    if (name.indexOf('microsoft') !== -1) score += 10;

    // Default voice tiebreaker
    if (v.default) score += 5;

    return score;
  }

  function populateVoiceSelect(voices) {
    if (!voiceSelect) return;
    voiceSelect.innerHTML = '';
    voices.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.voiceURI;
      var label = v.name + ' (' + v.lang + ')';
      if (!v.localService) label += ' [online]';
      opt.textContent = label;
      if (ptVoice && v.voiceURI === ptVoice.voiceURI) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
    voiceSelect.onchange = function () {
      var picked = availableVoices.find(function (v) { return v.voiceURI === voiceSelect.value; });
      if (picked) {
        ptVoice = picked;
        userPickedVoiceURI = picked.voiceURI;
        try { localStorage.setItem(CONFIG.VOICE_STORAGE_KEY, picked.voiceURI); } catch (err) { /* noop */ }
        // Preview
        previewVoice(picked);
      }
    };
  }

  function previewVoice(voice) {
    if (!ttsSupported) return;
    try { window.speechSynthesis.cancel(); } catch (err) { /* noop */ }
    var u = new SpeechSynthesisUtterance('Voz selecionada. Pronto.');
    u.voice = voice;
    u.lang = voice.lang || CONFIG.SPEECH_LANG;
    u.rate = CONFIG.TTS_RATE;
    u.pitch = CONFIG.TTS_PITCH;
    u.volume = CONFIG.TTS_VOLUME;
    window.speechSynthesis.speak(u);
  }

  function speak(text) {
    cancelTTS();
    showResponse(text);
    // Hard-pause STT while Jarvis speaks (avoid feedback loop)
    pauseRecognitionForTTS();

    if (ttsProvider === 'elevenlabs') {
      speakElevenLabs(text);
    } else {
      speakWebSpeech(text);
    }
  }

  function speakElevenLabs(text) {
    var seq = ++ttsRequestSeq;
    isProcessing = true;
    setStatus('PROCESSANDO', true);

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = setTimeout(function () {
      if (controller) controller.abort();
    }, CONFIG.ELEVENLABS_TIMEOUT_MS);

    var fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': CONFIG.ELEVENLABS_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ text: text }),
    };
    if (controller) fetchOpts.signal = controller.signal;

    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

    fetch(CONFIG.ELEVENLABS_WEBHOOK_URL, fetchOpts)
      .then(function (res) {
        if (!res.ok) {
          throw new Error('ElevenLabs webhook HTTP ' + res.status);
        }
        return res.blob();
      })
      .then(function (blob) {
        clearTimeout(timeoutId);
        if (seq !== ttsRequestSeq) {
          // Another speak() call superseded this one; discard
          return;
        }
        var t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        console.log('[Jarvis] ElevenLabs TTS latency:', Math.round(t1 - t0) + 'ms');

        var url = URL.createObjectURL(blob);
        currentAudioURL = url;
        var audio = new Audio(url);
        currentAudio = audio;

        // CRITICAL: set isSpeaking=true BEFORE play(). Doing this in
        // audio.onplay leaves a window where the TTS is starting to come
        // out of the speakers but the STT guard still sees isSpeaking=false,
        // and any onend/onresult firing in that window will re-open the mic.
        isProcessing = false;
        isSpeaking = true;
        setStatus('FALANDO', true);
        pauseRecognitionForTTS();

        audio.onplay = function () {
          // Reaffirm the abort once playback truly starts — covers cases
          // where Chrome might have re-attached the recognizer.
          pauseRecognitionForTTS();
        };
        audio.onended = function () {
          releaseAudio();
          handleTTSEnd();
        };
        audio.onerror = function () {
          console.warn('[Jarvis] Audio playback error — falling back to Web Speech.');
          releaseAudio();
          speakWebSpeech(text);
        };

        var playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function (err) {
            console.warn('[Jarvis] audio.play() rejected:', err && err.message);
            releaseAudio();
            // Reset flags so fallback can re-set them
            isSpeaking = false;
            speakWebSpeech(text);
          });
        }
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        if (seq !== ttsRequestSeq) return;
        isProcessing = false;
        console.warn('[Jarvis] ElevenLabs failed, fallback to Web Speech:', err && err.message);
        speakWebSpeech(text);
      });
  }

  function speakWebSpeech(text) {
    if (!ttsSupported) {
      handleTTSEnd();
      return;
    }
    try { window.speechSynthesis.cancel(); } catch (err) { /* noop */ }

    isSpeaking = true;
    setStatus('FALANDO', true);

    var utter = new SpeechSynthesisUtterance(text);
    if (ptVoice) {
      utter.voice = ptVoice;
      utter.lang = ptVoice.lang || CONFIG.SPEECH_LANG;
    } else {
      utter.lang = CONFIG.SPEECH_LANG;
    }
    utter.rate = CONFIG.TTS_RATE;
    utter.pitch = CONFIG.TTS_PITCH;
    utter.volume = CONFIG.TTS_VOLUME;
    utter.onend = handleTTSEnd;
    utter.onerror = handleTTSEnd;

    window.speechSynthesis.speak(utter);
  }

  function handleTTSEnd() {
    isSpeaking = false;
    ttsLevel = 0;
    if (isListening) {
      setStatus('OUVINDO', true);
      // Resume STT with a small delay so the tail of the TTS audio
      // (especially on bluetooth / cheap speakers with latency) doesn't
      // bleed into the mic and trigger another round.
      scheduleResumeRecognition();
    } else {
      setStatus('ESPERA', false);
    }
  }

  function releaseAudio() {
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.src = '';
      } catch (err) { /* noop */ }
      currentAudio.onplay = null;
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio = null;
    }
    if (currentAudioURL) {
      try { URL.revokeObjectURL(currentAudioURL); } catch (err) { /* noop */ }
      currentAudioURL = null;
    }
  }

  function cancelTTS() {
    ttsRequestSeq++; // invalidate any in-flight TTS fetch
    chatRequestSeq++; // invalidate any in-flight chat fetch
    if (sttResumeTimer) {
      clearTimeout(sttResumeTimer);
      sttResumeTimer = null;
    }
    if (ttsSupported) {
      try { window.speechSynthesis.cancel(); } catch (err) { /* noop */ }
    }
    releaseAudio();
    isProcessing = false;
    isSpeaking = false;
    ttsLevel = 0;
  }

  // --- Provider toggle (ElevenLabs / Web Speech) ---
  function setupProviderToggle() {
    if (!providerToggle) return;
    providerToggle.value = ttsProvider;
    providerToggle.onchange = function () {
      var v = providerToggle.value;
      if (v === 'webspeech' || v === 'elevenlabs') {
        ttsProvider = v;
        try { localStorage.setItem(CONFIG.TTS_PROVIDER_STORAGE_KEY, v); } catch (err) { /* noop */ }
        applyProviderUI();
      }
    };
    applyProviderUI();
  }

  function applyProviderUI() {
    // Hide voice picker when ElevenLabs is active (only relevant for Web Speech)
    var picker = document.querySelector('.voice-picker');
    if (picker) {
      picker.style.display = (ttsProvider === 'webspeech') ? 'flex' : 'none';
    }
  }

  // --- Floating response UI (word-by-word fade) ---
  function showResponse(text) {
    if (!responseContainer || !text) return;
    var seq = ++responseSeq;
    var oldWords = responseContainer.querySelectorAll('.word');
    var oldLen = oldWords.length;

    // Fade out existing words
    for (var i = 0; i < oldLen; i++) {
      var w = oldWords[i];
      w.style.transitionDuration = CONFIG.WORD_FADE_TRANSITION_MS + 'ms';
      w.style.transitionDelay = (i * CONFIG.WORD_FADE_OUT_MS) + 'ms';
      w.style.opacity = '0';
    }

    var clearDelay = oldLen ? (oldLen * CONFIG.WORD_FADE_OUT_MS + CONFIG.WORD_FADE_TRANSITION_MS) : 0;

    setTimeout(function () {
      if (seq !== responseSeq) return; // newer response superseded us
      responseContainer.innerHTML = '';
      var words = String(text).split(/\s+/).filter(Boolean);
      for (var j = 0; j < words.length; j++) {
        (function (idx, word) {
          var span = document.createElement('span');
          span.className = 'word';
          span.textContent = word;
          responseContainer.appendChild(span);
          // Two RAFs to ensure the initial opacity:0 paints before transition
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              if (seq !== responseSeq) return;
              span.style.transitionDelay = (idx * CONFIG.WORD_FADE_IN_MS) + 'ms';
              span.style.opacity = String(CONFIG.WORD_TARGET_OPACITY);
            });
          });
        })(j, words[j]);
      }
    }, clearDelay);
  }

  function clearResponse() {
    if (!responseContainer) return;
    var seq = ++responseSeq;
    var words = responseContainer.querySelectorAll('.word');
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      w.style.transitionDelay = (i * CONFIG.WORD_FADE_OUT_MS) + 'ms';
      w.style.opacity = '0';
    }
    setTimeout(function () {
      if (seq === responseSeq) responseContainer.innerHTML = '';
    }, words.length * CONFIG.WORD_FADE_OUT_MS + CONFIG.WORD_FADE_TRANSITION_MS);
  }

  // --- Particles ---
  function createParticles() {
    particles = [];
    for (var i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
      var ringIndex = Math.floor(Math.random() * CONFIG.RING_COUNT);
      var baseRadius = CONFIG.CORE_RADIUS + (ringIndex + 1) * CONFIG.RING_GAP;
      var angle = Math.random() * Math.PI * 2;
      var speed = (0.5 + Math.random() * 0.5) * (Math.random() > 0.5 ? 1 : -1);
      var size = 1 + Math.random() * 2.5;

      particles.push({
        angle: angle,
        baseRadius: baseRadius,
        radius: baseRadius,
        speed: speed,
        size: size,
        ringIndex: ringIndex,
        offsetPhase: Math.random() * Math.PI * 2,
        offsetAmplitude: 3 + Math.random() * 8,
        opacity: 0.3 + Math.random() * 0.7,
        colorMix: Math.random(), // 0 = primary, 1 = secondary
      });
    }
  }

  function createRings() {
    rings = [];
    for (var i = 0; i < CONFIG.RING_COUNT; i++) {
      rings.push({
        baseRadius: CONFIG.CORE_RADIUS + (i + 1) * CONFIG.RING_GAP,
        rotation: Math.random() * Math.PI * 2,
        speed: (0.3 + Math.random() * 0.4) * (i % 2 === 0 ? 1 : -1),
        dashOffset: 0,
      });
    }
  }

  // --- Drawing ---
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpColor(c1, c2, t) {
    return {
      r: Math.round(lerp(c1.r, c2.r, t)),
      g: Math.round(lerp(c1.g, c2.g, t)),
      b: Math.round(lerp(c1.b, c2.b, t)),
    };
  }

  function drawCore(level) {
    var pulse = Math.sin(time * CONFIG.IDLE_PULSE_SPEED) * CONFIG.IDLE_PULSE_AMOUNT;
    var scale = 1 + pulse + level * 0.3;
    var radius = CONFIG.CORE_RADIUS * scale;

    // Outer glow
    var gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.2, centerX, centerY, radius * 2.5);
    var glowAlpha = (0.08 + level * 0.12) * CONFIG.GLOW_INTENSITY;
    gradient.addColorStop(0, 'rgba(0, 212, 255, ' + (glowAlpha * 2) + ')');
    gradient.addColorStop(0.4, 'rgba(0, 212, 255, ' + glowAlpha + ')');
    gradient.addColorStop(1, 'rgba(0, 212, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Core circle — solid border
    ctx.strokeStyle = 'rgba(0, 212, 255, ' + (0.3 + level * 0.4) + ')';
    ctx.lineWidth = 1.5 + level * 1;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner fill
    var innerGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
    innerGrad.addColorStop(0, 'rgba(0, 212, 255, ' + (0.05 + level * 0.08) + ')');
    innerGrad.addColorStop(0.7, 'rgba(0, 180, 220, ' + (0.02 + level * 0.04) + ')');
    innerGrad.addColorStop(1, 'rgba(0, 150, 200, 0)');
    ctx.fillStyle = innerGrad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();

    // Inner arc decorations (rotating arcs)
    ctx.save();
    ctx.translate(centerX, centerY);
    for (var i = 0; i < 4; i++) {
      var arcAngle = time * 0.001 * (i % 2 === 0 ? 1 : -1) + (i * Math.PI / 2);
      var arcLength = Math.PI * 0.3 + level * Math.PI * 0.2;
      var arcRadius = radius * (0.6 + i * 0.1);
      ctx.strokeStyle = 'rgba(0, 212, 255, ' + (0.15 + level * 0.2) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, arcRadius, arcAngle, arcAngle + arcLength);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRings(level) {
    for (var i = 0; i < rings.length; i++) {
      var ring = rings[i];
      var pulse = Math.sin(time * CONFIG.IDLE_PULSE_SPEED + i) * CONFIG.IDLE_PULSE_AMOUNT;
      var scale = 1 + pulse + level * 0.15;
      var radius = ring.baseRadius * scale;

      ring.rotation += ring.speed * CONFIG.BASE_SPEED * (1 + level * 3);
      ring.dashOffset += (1 + level * 5) * 0.5;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(ring.rotation);

      // Dashed ring
      ctx.setLineDash([12 + level * 8, 20 - level * 5]);
      ctx.lineDashOffset = ring.dashOffset;
      ctx.strokeStyle = 'rgba(0, 212, 255, ' + (0.08 + level * 0.15 + i * 0.03) + ')';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    }
  }

  function drawParticles(level) {
    var pulse = Math.sin(time * CONFIG.IDLE_PULSE_SPEED) * CONFIG.IDLE_PULSE_AMOUNT;

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];

      // Update angle — faster with audio
      var speedMult = 1 + level * 4;
      p.angle += p.speed * CONFIG.BASE_SPEED * speedMult;

      // Oscillate radius
      var offset = Math.sin(time * 0.003 + p.offsetPhase) * p.offsetAmplitude * (1 + level * 2);
      var ringScale = 1 + pulse + level * 0.15;

      // Recalculate base radius in case of resize
      p.baseRadius = CONFIG.CORE_RADIUS + (p.ringIndex + 1) * CONFIG.RING_GAP;
      p.radius = p.baseRadius * ringScale + offset;

      // Position
      var x = centerX + Math.cos(p.angle) * p.radius;
      var y = centerY + Math.sin(p.angle) * p.radius;

      // Color based on audio level
      var color;
      if (level > 0.5) {
        color = lerpColor(CONFIG.COLOR_PRIMARY, CONFIG.COLOR_SECONDARY, (level - 0.5) * 2 * p.colorMix);
      } else {
        color = lerpColor(CONFIG.COLOR_ACCENT, CONFIG.COLOR_PRIMARY, level * 2);
      }

      // Size reacts to audio
      var size = p.size * (1 + level * 1.5);

      // Opacity
      var alpha = p.opacity * (0.5 + level * 0.5);

      // Draw particle with glow
      ctx.fillStyle = 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + alpha + ')';
      ctx.shadowColor = 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + (alpha * 0.5) + ')';
      ctx.shadowBlur = 4 + level * 8;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function drawScanLine(level) {
    // Rotating scan line from center
    var scanAngle = time * 0.0015;
    var scanLength = CONFIG.CORE_RADIUS + CONFIG.RING_COUNT * CONFIG.RING_GAP + 40;
    var scale = 1 + level * 0.2;
    scanLength *= scale;

    var x2 = centerX + Math.cos(scanAngle) * scanLength;
    var y2 = centerY + Math.sin(scanAngle) * scanLength;

    var grad = ctx.createLinearGradient(centerX, centerY, x2, y2);
    grad.addColorStop(0, 'rgba(0, 212, 255, 0)');
    grad.addColorStop(0.3, 'rgba(0, 212, 255, ' + (0.05 + level * 0.1) + ')');
    grad.addColorStop(1, 'rgba(0, 212, 255, 0)');

    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawFrequencyBars(level) {
    if (!dataArray || !isListening) return;

    var barCount = 32;
    var step = Math.floor(dataArray.length / barCount);

    ctx.save();
    ctx.translate(centerX, centerY);

    for (var i = 0; i < barCount; i++) {
      var value = dataArray[i * step] / 255;
      var angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
      var innerR = CONFIG.CORE_RADIUS * 0.85;
      var outerR = innerR + value * 30;

      var x1 = Math.cos(angle) * innerR;
      var y1 = Math.sin(angle) * innerR;
      var x2 = Math.cos(angle) * outerR;
      var y2 = Math.sin(angle) * outerR;

      ctx.strokeStyle = 'rgba(0, 212, 255, ' + (0.2 + value * 0.5) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawBackground() {
    // Subtle grid
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.02)';
    ctx.lineWidth = 0.5;
    var gridSize = 60;
    var w = canvas.width / dpr;
    var h = canvas.height / dpr;

    for (var x = 0; x < w; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (var y = 0; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  // --- Main loop ---
  function animate(timestamp) {
    time = timestamp || 0;

    // Get audio level (mic OR synthetic during TTS/processing)
    if (isSpeaking) {
      // Synthetic oscillating level so the circle "speaks back"
      var base = 0.45;
      var osc = Math.sin(time * 0.012) * 0.18 + Math.sin(time * 0.027) * 0.12 + Math.sin(time * 0.055) * 0.08;
      var target = Math.max(0, Math.min(1, base + osc));
      ttsLevel += (target - ttsLevel) * 0.25;
      audioLevel = ttsLevel;
    } else if (isProcessing) {
      // Slow gentle pulse while waiting for ElevenLabs response
      var procPulse = 0.18 + Math.abs(Math.sin(time * 0.004)) * 0.22;
      ttsLevel += (procPulse - ttsLevel) * 0.1;
      audioLevel = ttsLevel;
    } else if (isListening) {
      audioLevel = getAudioLevel();
    } else {
      audioLevel *= 0.95; // fade out
    }

    // Smooth the level for visual transitions
    smoothedLevel += (audioLevel - smoothedLevel) * 0.15;

    // Clear canvas
    var w = canvas.width / dpr;
    var h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // Draw layers
    drawBackground();
    drawScanLine(smoothedLevel);
    drawRings(smoothedLevel);
    drawParticles(smoothedLevel);
    drawCore(smoothedLevel);
    drawFrequencyBars(smoothedLevel);

    // Update volume meter
    if (isListening) {
      updateVolumeMeter(smoothedLevel);
    }

    requestAnimationFrame(animate);
  }

  // --- Start ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
