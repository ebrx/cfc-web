var Sink = function () {

  var _fountainBuff = undefined;
  var _errBuff = undefined;
  var _errBuffSize = 1024;

  function fountain_buff() {
    if (_fountainBuff.buffer !== Module.HEAPU8.buffer) {
      _fountainBuff = new Uint8Array(Module.HEAPU8.buffer, _fountainBuff.byteOffset, _fountainBuff.byteLength);
    }
    return _fountainBuff;
  }

  // public interface
  return {
    allocate: function () {
      const size = Module._cimbard_get_bufsize(); // max length of buff. We could also resize as we go...
      if (_fountainBuff && size > _fountainBuff.length) {
        Module._free(_fountainBuff.byteOffset);
        _fountainBuff = undefined;
      }
      if (_fountainBuff === undefined) {
        const dataPtr = Module._malloc(size);
        _fountainBuff = new Uint8Array(Module.HEAPU8.buffer, dataPtr, size);
      }
    },

    on_decode: function (buff) {
      if (buff.length == 0) { // sanity check
        return;
      }
      const fountBuff = fountain_buff();
      fountBuff.set(buff);

      console.log('sink decode ' + fountBuff); //TODO: base64?
      var res = Module._cimbard_fountain_decode(fountBuff.byteOffset, buff.length);
      console.log("on decode got res " + res);

      const report = Sink.get_report();
      if (Array.isArray(report)) {
        Recv.render_progress(report);
      }
      else {
        Recv.set_HTML("tdec", "decode " + res + ". " + report);
      }

      if (res > 0) {
        const res32t = Number(res & 0xFFFFFFFFn);; // truncate BigInt res (int64_t) to a uint32_t
        Sink.reassemble_file(res32t);
      }
    },

    get_report: function () {
      if (_errBuff === undefined) {
        _errBuff = Module._malloc(_errBuffSize);
      }
      const errlen = Module._cimbard_get_report(_errBuff, _errBuffSize);
      if (errlen > 0) {
        const errview = new Uint8Array(Module.HEAPU8.buffer, _errBuff, errlen);
        const td = new TextDecoder();
        const text = td.decode(errview);
        try {
          return JSON.parse(text);
        } catch (error) {
          return text;
        }
      }
    },

    reassemble_file: function (id) {
      const size = Module._cimbard_get_filesize(id);
      //alert("we did it!?! " + size);
      try {
        var name = id + "." + size;
        const fnsize = Module._cimbard_get_filename(id, _errBuff, _errBuffSize);
        if (fnsize < 0) {
          alert("reassemble_file failed :(" + res);
          console.log("we biffed it. :( " + res);
          Recv.set_HTML("errorbox", "reassemble_file failed :( " + res);
        }
        else if (fnsize > 0) {
          const temparr = new Uint8Array(Module.HEAPU8.buffer, _errBuff, fnsize);
          name = new TextDecoder("utf-8").decode(temparr);
        }
        Zstd.decompress(name, id);
        Recv.flash_done();
      } catch (error) {
        console.log("failed finish copy or download?? " + error);
      }
    }
  };
}();


var Recv = function () {

  var _counter = 0;
  var _recentDecode = -1;
  var _recentExtract = -1;
  var _renderTime = 0;
  var _captureNextFrame = 0;

  var _watchmanEnabled = 0;
  var _watchmanLastSeen = 1; // start at 1, can't restart if we never started

  var _video = 0;
  var _workers = [];
  var _nextWorker = 0;
  var _workerReady;
  var _framesInFlight = 0;
  var _supportedFormats = ["NV12", "I420"]; // have cimbard_* return this somehow?

  var _mode = 0;

  // iOS-compatible capture: draw the <video> to a canvas and read RGBA pixels.
  // (WebCodecs VideoFrame + requestVideoFrameCallback are Chromium-only.)
  var _captureCanvas = 0;
  var _captureCtx = 0;
  var _lastCapture = 0;
  var _captureMinIntervalMs = 60; // ~16 fps

  function isIOS() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAppleDevice = navigator.userAgent.includes('Macintosh');
    const isTouchScreen = navigator.maxTouchPoints >= 1;
    return isIOS || (isAppleDevice && isTouchScreen);
  }

  // ---- scan UI: aiming guide + progress ring ------------------------------
  // The scan frame is CSS-centered, so there's no per-mode crosshair geometry
  // to compute anymore. We only drive a state (idle / scanning / receiving /
  // done) + a bilingual hint, and a progress ring around the frame.
  var _scanState = 'idle';
  var _doneUntil = 0; // timestamp; while in the future we force the 'done' state

  var _scanStrings = {
    idle: { zh: '将彩色码对准取景框', en: 'Point the camera at the colored code' },
    scanning: { zh: '正在识别…', en: 'Scanning…' },
    receiving: { zh: '正在接收', en: 'Receiving' },
    done: { zh: '接收完成', en: 'Done' }
  };

  function _renderScanHint() {
    var hint = document.getElementById('scan-hint');
    if (!hint) return;
    var s = _scanStrings[_scanState] || _scanStrings.idle;
    hint.textContent = (_camLang === 'en') ? s.en : s.zh;
  }

  function _startCaptureLoop() {
    if (!_captureCanvas) {
      _captureCanvas = document.createElement('canvas');
      _captureCtx = _captureCanvas.getContext('2d', { willReadFrequently: true });
    }
    function _loop(ts) {
      Recv.on_frame(ts || performance.now());
      requestAnimationFrame(_loop);
    }
    requestAnimationFrame(_loop);
  }

  // ---- camera status / error overlay -------------------------------------
  // We never dump raw getUserMedia errors onto the page. Instead we map them
  // to a friendly, actionable, bilingual card and keep the technical detail in
  // console (and the hidden debug box) only. The overlay is rendered from a
  // state id + the current language, so switching language re-renders live.
  var _camState = 0; // current overlay state id, or 0 when hidden
  var _camLang = (typeof CFCLang !== 'undefined') ? CFCLang.get() : 'zh';

  var _camMsgs = {
    starting: {
      zh: { spinner: true, title: '正在启动摄像头…', msg: '请在弹出的提示中允许使用摄像头。' },
      en: { spinner: true, title: 'Starting camera…', msg: 'Please allow camera access in the prompt.' }
    },
    denied: {
      zh: { icon: '🔒', title: '摄像头权限被拒绝', msg: '需要使用摄像头才能扫码接收文件。请允许摄像头权限后重试。',
            hint: '如果之前点了「禁止」：点地址栏的 <b>🔒 / ⋯</b> → 网站设置 → 摄像头 → 允许，再点下面重试。', retry: true },
      en: { icon: '🔒', title: 'Camera access blocked', msg: 'The camera is required to scan and receive files. Please allow camera access and retry.',
            hint: 'Tapped “Block” earlier? Open the <b>🔒 / ⋯</b> menu in the address bar → Site settings → Camera → Allow, then retry below.', retry: true }
    },
    notfound: {
      zh: { icon: '🎥', title: '没有可用的摄像头', msg: '没检测到摄像头设备。请确认设备有摄像头，且未被系统禁用。', retry: true },
      en: { icon: '🎥', title: 'No camera available', msg: 'No camera was detected. Make sure your device has a camera that isn’t disabled.', retry: true }
    },
    inuse: {
      zh: { icon: '⚠️', title: '摄像头被占用', msg: '摄像头可能正被其他应用使用。请关闭其它用到摄像头的程序后重试。', retry: true },
      en: { icon: '⚠️', title: 'Camera in use', msg: 'The camera may be in use by another app. Close other apps using the camera and retry.', retry: true }
    },
    incompatible: {
      zh: { icon: '🎥', title: '摄像头不兼容', msg: '当前摄像头不满足参数要求。请重试，或更换设备。', retry: true },
      en: { icon: '🎥', title: 'Camera not compatible', msg: 'This camera doesn’t meet the required settings. Retry, or try another device.', retry: true }
    },
    insecure: {
      zh: { icon: '🔒', title: '需要安全连接 (HTTPS)', msg: '此页面无法访问摄像头，通常是因为不是 HTTPS。请用 <b>https://</b> 链接打开本页面。', retry: false },
      en: { icon: '🔒', title: 'Secure connection required (HTTPS)', msg: 'This page can’t access the camera, usually because it isn’t HTTPS. Please open it over an <b>https://</b> link.', retry: false }
    },
    generic: {
      zh: { icon: '📷', title: '摄像头无法启动', msg: '摄像头初始化失败，请重试。', retry: true },
      en: { icon: '📷', title: 'Camera failed to start', msg: 'Camera initialization failed. Please retry.', retry: true }
    }
  };

  var _camChrome = {
    zh: { retry: '重新授权', back: '← 返回首页' },
    en: { retry: 'Retry', back: '← Home' }
  };

  function _camEl(id) { return document.getElementById(id); }

  function _errToState(err) {
    switch ((err && err.name) || '') {
      case 'NotAllowedError':
      case 'PermissionDeniedError': return 'denied';
      case 'NotFoundError':
      case 'DevicesNotFoundError': return 'notfound';
      case 'NotReadableError':
      case 'TrackStartError': return 'inuse';
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError': return 'incompatible';
      case 'SecurityError': return 'insecure';
      default: return 'generic';
    }
  }

  function _renderCamCard() {
    var chrome = _camChrome[_camLang] || _camChrome.zh;
    var retryBtn = _camEl('cam-retry');
    var backLink = document.querySelector('#cam-overlay .cam-back');
    if (retryBtn) retryBtn.textContent = chrome.retry;
    if (backLink) backLink.textContent = chrome.back;

    if (!_camState) return;
    var entry = _camMsgs[_camState];
    var opts = entry ? (entry[_camLang] || entry.zh) : null;
    if (!opts) return;
    _camEl('cam-icon').classList.toggle('invisible', !!opts.spinner);
    _camEl('cam-spinner').classList.toggle('invisible', !opts.spinner);
    _camEl('cam-icon').textContent = opts.icon || '📷';
    _camEl('cam-title').textContent = opts.title || '';
    _camEl('cam-msg').innerHTML = opts.msg || '';
    var hint = _camEl('cam-hint');
    if (opts.hint) { hint.innerHTML = opts.hint; hint.classList.remove('invisible'); }
    else { hint.classList.add('invisible'); }
    if (retryBtn) retryBtn.classList.toggle('invisible', !opts.retry);
  }

  function _showCamCard(stateId) {
    _camState = stateId;
    _renderCamCard();
    var overlay = _camEl('cam-overlay');
    if (overlay) overlay.classList.remove('invisible');
  }

  function _hideCamCard() {
    _camState = 0;
    var overlay = _camEl('cam-overlay');
    if (overlay) overlay.classList.add('invisible');
  }

  // public interface
  return {
    init: function (video, num_workers) {
      Recv.init_ww(num_workers);
      Recv.init_video(video);
    },

    set_error: function (msg) {
      Recv.set_HTML('errorbox', msg);
      return false;
    },

    ww_ready: new Promise(resolve => {
      _workerReady = resolve;
    }),

    frames_in_flight_incr: function () {
      _framesInFlight += 1;
      document.getElementById('framesInFlight').innerHTML = _framesInFlight;
    },

    frames_in_flight_decr: function () {
      _framesInFlight -= 1;
      document.getElementById('framesInFlight').innerHTML = _framesInFlight;
    },

    init_ww: function (num_workers) {
      // clean up _workers if exists?
      _workers = [];
      for (let i = 0; i < num_workers; i++) {
        _workers.push(new Worker('recv-worker.js'));

        _workers[i].onmessage = (event) => {
          Recv.on_decode(i, event.data);
        };

        _workers[i].onerror = (error) => {
          console.error('Worker' + i + ' error:', error);
        };
      }
    },

    // `silent` is used by the watchman's periodic restart — it shouldn't flash
    // the status card on every recovery attempt.
    init_video: function (video, silent) {
      _video = video;

      // Keep constraints simple/portable. iOS Safari rejects the whole call if it
      // dislikes a constraint, and silently shows no prompt; nonstandard ones
      // (exposureMode/focusMode) and hard `min` widths are the usual offenders.
      var constraints = {
        audio: false,
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: { ideal: 'environment' },
          frameRate: { ideal: 15 }
        }
      };

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (!silent) _showCamCard('insecure');
        return Recv.set_error('mediaDevices not supported');
      }

      // iOS needs these attributes for inline autoplay of the camera stream.
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.muted = true;

      // elegant "starting" state while the permission prompt is up
      if (!silent) _showCamCard('starting');

      navigator.mediaDevices.getUserMedia(constraints)
        .then(localMediaStream => {
          if ('srcObject' in video) {
            video.srcObject = localMediaStream;
          } else {
            video.src = URL.createObjectURL(localMediaStream); //deprecated
          }
          return video.play();
        })
        .then(() => {
          _hideCamCard();
          Recv.set_HTML("errorbox", "");
          _startCaptureLoop();
        })
        .catch(err => {
          // technical detail stays in console + hidden debug box only
          console.error('camera init failed', err);
          Recv.set_error('camera init failed: ' + ((err && err.name) || '') + ' ' + ((err && err.message) || ''));
          if (!silent) _showCamCard(_errToState(err));
        });
    },

    retryCamera: function () {
      _hideCamCard();
      if (_video) Recv.init_video(_video);
    },

    // called by the language toggle; re-renders the overlay + scan hint in place
    applyLang: function (l) {
      _camLang = (l === 'en') ? 'en' : 'zh';
      _renderCamCard();
      _renderScanHint();
    },

    watch_for_camera_pause: function () {
      // only call this after our first success
      if (_watchmanEnabled) {
        return;
      }
      _watchmanEnabled = true;

      // ios only for now, since desktop behavior is weird
      if (!isIOS()) {
        return;
      }

      // periodically make sure the camera capture is running
      setInterval(Recv.restart_paused_camera, 1000);
    },

    restart_paused_camera: function () {
      if (!_video) {
        return;
      }

      // if we're still incrementing, do nothing
      if (_counter > _watchmanLastSeen) {
        _watchmanLastSeen = _counter;
        return;
      }

      // if not, we're stuck?
      Recv.init_video(_video, true);
    },

    download_bytes: function (buff, name) {
      var blob = new Blob([buff], { type: 'application/octet-stream' });
      Zstd.download_blob(name, blob);
    },

    on_decode: function (wid, data) {
      //console.log('Main thread received message from worker' + wid + ':', data);
      Recv.frames_in_flight_decr();
      // if extract but no bytes, log extract counte
      if (data.nodata) {
        _recentExtract = _counter;
        return;
      }
      if (data.failed_extract) { // very common, nothing to do
        return;
      }
      if (data.res) {
        Recv.set_HTML("t" + wid, "msg is " + data.res);
        return;
      }
      if (data.ready) {
        if (_workerReady)
          _workerReady();
        return;
      }

      // should be a decode with some bytes, so set decodecounter
      _recentDecode = _counter;

      const buff = data.buff;
      if (buff.length > 0) {
        Recv.setMode(data.mode); // call *before* we send it to the sink. This is our autodetect confirm.
      }
      Recv.set_HTML("t" + wid, "mode is " + _mode + ", len() is " + buff.length + ", buff: " + buff);
      Sink.on_decode(buff);
    },

    on_frame: function (now) {
      _counter += 1;
      if (_workers.length == 0)
        return;

      // piggyback off this call to make sure our visual state is correct
      Recv.update_visual_state();
      // make sure the camera feed stays up
      Recv.watch_for_camera_pause();

      if (!_video || !_video.videoWidth || !_video.videoHeight)
        return;
      // throttle to ~16fps regardless of the rAF rate
      if (now - _lastCapture < _captureMinIntervalMs)
        return;
      _lastCapture = now;

      if (_framesInFlight > 20) {
        return; // worker queues full
      }
      if (_nextWorker >= _workers.length)
        _nextWorker = 0;

      const modeVals = [66, 68, 67, 4];
      const width = _video.videoWidth;
      const height = _video.videoHeight;
      if (_captureCanvas.width !== width || _captureCanvas.height !== height) {
        _captureCanvas.width = width;
        _captureCanvas.height = height;
      }
      try {
        _captureCtx.drawImage(_video, 0, 0, width, height);
        const imgData = _captureCtx.getImageData(0, 0, width, height); // RGBA
        const buff = new Uint8Array(imgData.data.buffer);
        Recv.frames_in_flight_incr();
        if (_captureNextFrame == 1) {
          _captureNextFrame = 0;
          Recv.download_bytes(buff.slice(), width + "x" + height + "x" + _counter + ".RGBA");
        }
        let mode = _mode || modeVals[_counter % modeVals.length];
        _workers[_nextWorker].postMessage({ type: 'proc', pixels: buff, format: 'RGBA', width: width, height: height, mode: mode }, [buff.buffer]);
        _nextWorker += 1;
      } catch (e) {
        console.log(e);
        Recv.set_error("capture failed: " + e);
      }
    },

    captureFrame: function () {
      _captureNextFrame = 1;
      alert("about to capture!");
    },

    download_bytes: function (buff, name) {
      var blob = new Blob([buff], { type: 'application/octet-stream' });
      Zstd.download_blob(name, blob);
    },

    update_visual_state: function () {
      // derive a single scan state from the recent decode/extract counters and
      // reflect it on the frame (color) + the hint text.
      var state;
      if (performance.now() < _doneUntil) {
        state = 'done';
      }
      else if (_recentDecode > 0 && _recentDecode + 30 > _counter) {
        state = 'receiving';
      }
      else if (_recentExtract > 0 && _recentExtract + 30 > _counter) {
        state = 'scanning';
      }
      else {
        state = 'idle';
      }

      if (state !== _scanState) {
        _scanState = state;
        var frame = document.getElementById('scan-frame');
        if (frame) frame.setAttribute('data-state', state);
        _renderScanHint();
        // clear the ring + percent whenever we drop back to idle/scanning
        if (state === 'idle' || state === 'scanning') {
          Recv.set_ring(0);
          var pct = document.getElementById('scan-pct');
          if (pct) pct.textContent = '';
        }
      }
    },

    // progress 0..1 -> sweep the ring around the frame
    set_ring: function (frac) {
      var fill = document.querySelector('#progress-ring .ring-fill');
      if (!fill) return;
      var clamped = Math.max(0, Math.min(1, frac));
      fill.style.strokeDashoffset = (100 - clamped * 100).toString();
    },

    render_progress: function (report) {
      Recv.set_HTML("tdec", "progress " + report);
      if (!report || !report.length) return;

      // overall progress = average across fountain streams
      var sum = 0;
      for (var i = 0; i < report.length; i++) sum += report[i];
      var frac = sum / report.length;

      Recv.set_ring(frac);
      var pct = document.getElementById('scan-pct');
      if (pct) pct.textContent = Math.round(frac * 100) + '%';
    },

    // briefly flash a "done" state when a file finishes reassembling
    flash_done: function () {
      _doneUntil = performance.now() + 2500;
      var frame = document.getElementById('scan-frame');
      if (frame) frame.setAttribute('data-state', 'done');
      _scanState = 'done';
      Recv.set_ring(1);
      _renderScanHint();
    },

    showDebug: function () {
      document.getElementById("debug-button").focus();
    },

    setMode: function (modeVal) {
      // these should be moved elsewhere...
      const modeToString = {
        4: "4C",
        8: "8C",
        66: "Bu",
        67: "Bm",
        68: "B"
      };
      let modeStringToVal = {
        "Auto": 0
      };
      for (const val in modeToString) {
        modeStringToVal[modeToString[val]] = val;
      }

      if (modeVal in modeStringToVal) {
        modeVal = modeStringToVal[modeVal];
      }

      // configure wasm in main thread. Mode selection is auto-only now (the
      // Auto/B picker was removed); on_decode still calls this to lock onto the
      // detected mode once a frame decodes.
      _mode = modeVal;
      if (_mode > 0) {
        Module._cimbard_configure_decode(_mode);
        Sink.allocate();
      }
    },

    set_HTML: function (id, msg, only_if_unset) {
      const elem = document.getElementById(id);
      if (only_if_unset && elem.innerHTML) {
        return;
      }
      elem.innerHTML = msg;
    },

    set_title: function (msg) {
      document.title = "Cimbar: " + msg;
    }
  };
}();
