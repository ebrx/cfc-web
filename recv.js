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

  function _toggleFullscreen() {
    if (document.fullscreenElement) {
      return document.exitFullscreen();
    }
    else {
      return document.documentElement.requestFullscreen();
    }
  }

  function isIOS() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAppleDevice = navigator.userAgent.includes('Macintosh');
    const isTouchScreen = navigator.maxTouchPoints >= 1;
    return isIOS || (isAppleDevice && isTouchScreen);
  }

  function _getModeAspectRatio(mode) {
    // (image_size_x + 16) / (image_size_y + 16)
    switch (mode) {
      case 66: return 1.1516; // Bu
      case 67: return 1.413;  // Bm
      default: return 1.0;    // B, 4C, auto
    }
  }

  function _updateCrosshairPositions() {
    if (!_video || !_video.videoWidth || !_video.videoHeight)
      return;

    var modeAspect = _getModeAspectRatio(_mode);

    var windowW = window.innerWidth;
    var windowH = window.innerHeight;
    var camAspect = _video.videoWidth / _video.videoHeight;
    var windowAspect = windowW / windowH;

    var vidW = windowW;
    var vidH = windowH;
    if (camAspect > windowAspect)  // black bars top/bottom
      vidH = vidW / camAspect;
    else  // black bars left/right
      vidW = vidH * camAspect;

    var offsetY;
    var offsetX;
    if (windowH > windowW) {
      // portrait
      offsetY = (windowH - (vidW * modeAspect)) / 2;
      offsetX = (windowW - vidW) / 2;
    }
    else {
      offsetY = (windowH - vidH) / 2;
      offsetX = (windowW - (vidH * modeAspect)) / 2;
    }

    var logme = "crosshair offsets now " + offsetX + ", " + offsetY;
    //Recv.set_error(logme);
    console.log(logme);

    var xh1 = document.getElementById("crosshair1");
    var xh2 = document.getElementById("crosshair2");
    xh1.style.top = offsetY + "px";
    xh1.style.right = offsetX + "px";
    xh2.style.bottom = offsetY + "px";
    xh2.style.left = offsetX + "px";
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
  // to a friendly, actionable card and keep the technical detail in console
  // (and the hidden debug box) only.
  function _camEl(id) { return document.getElementById(id); }

  function _showCamCard(opts) {
    var overlay = _camEl('cam-overlay');
    if (!overlay) return;
    _camEl('cam-icon').classList.toggle('invisible', !!opts.spinner);
    _camEl('cam-spinner').classList.toggle('invisible', !opts.spinner);
    _camEl('cam-icon').textContent = opts.icon || '📷';
    _camEl('cam-title').textContent = opts.title || '';
    _camEl('cam-msg').innerHTML = opts.msg || '';
    var hint = _camEl('cam-hint');
    if (opts.hint) { hint.innerHTML = opts.hint; hint.classList.remove('invisible'); }
    else { hint.classList.add('invisible'); }
    _camEl('cam-retry').classList.toggle('invisible', !opts.retry);
    overlay.classList.remove('invisible');
  }

  function _hideCamCard() {
    var overlay = _camEl('cam-overlay');
    if (overlay) overlay.classList.add('invisible');
  }

  function _friendlyCameraError(err) {
    switch ((err && err.name) || '') {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return {
          icon: '🔒',
          title: '摄像头权限被拒绝',
          msg: '需要使用摄像头才能扫码接收文件。请允许摄像头权限后重试。',
          hint: '如果之前点了「禁止」：点地址栏的 <b>🔒 / ⋯</b> → 网站设置 → 摄像头 → 允许，再点下面重试。',
          retry: true
        };
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return {
          icon: '🎥',
          title: '没有可用的摄像头',
          msg: '没检测到摄像头设备。请确认设备有摄像头，且未被系统禁用。',
          retry: true
        };
      case 'NotReadableError':
      case 'TrackStartError':
        return {
          icon: '⚠️',
          title: '摄像头被占用',
          msg: '摄像头可能正被其他应用使用。请关闭其它用到摄像头的程序后重试。',
          retry: true
        };
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return {
          icon: '🎥',
          title: '摄像头不兼容',
          msg: '当前摄像头不满足参数要求。请重试，或更换设备。',
          retry: true
        };
      case 'SecurityError':
        return {
          icon: '🔒',
          title: '需要安全连接 (HTTPS)',
          msg: '摄像头要求 HTTPS。请用 <b>https://</b> 链接打开本页面。',
          retry: false
        };
      default:
        return {
          icon: '📷',
          title: '摄像头无法启动',
          msg: '摄像头初始化失败，请重试。',
          retry: true
        };
    }
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
      window.addEventListener('resize', _updateCrosshairPositions);

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
        if (!silent) _showCamCard({
          icon: '🔒',
          title: '需要安全连接 (HTTPS)',
          msg: '此浏览器无法访问摄像头，通常是因为页面不是 HTTPS。请用 <b>https://</b> 链接打开。',
          retry: false
        });
        return Recv.set_error('mediaDevices not supported');
      }

      // iOS needs these attributes for inline autoplay of the camera stream.
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.muted = true;

      // elegant "starting" state while the permission prompt is up
      if (!silent) _showCamCard({
        spinner: true,
        title: '正在启动摄像头…',
        msg: '请在弹出的提示中允许使用摄像头。',
        retry: false
      });

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
          Recv.set_HTML("crosshair1", "");
          Recv.set_HTML("errorbox", "");
          _startCaptureLoop();
        })
        .catch(err => {
          // technical detail stays in console + hidden debug box only
          console.error('camera init failed', err);
          Recv.set_error('camera init failed: ' + ((err && err.name) || '') + ' ' + ((err && err.message) || ''));
          if (!silent) _showCamCard(_friendlyCameraError(err));
        });
    },

    retryCamera: function () {
      _hideCamCard();
      if (_video) Recv.init_video(_video);
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
      _updateCrosshairPositions();

      // check counters
      var xh1 = document.getElementById("crosshair1");
      var xh2 = document.getElementById("crosshair2");
      if (_recentDecode > 0 && _recentDecode + 30 > _counter) {
        xh1.classList.add("active_xhairs");
        xh1.classList.remove("scanning_xhairs");
        xh2.classList.add("active_xhairs");
        xh1.classList.remove("scanning_xhairs");
      }
      else if (_recentExtract > 0 && _recentExtract + 30 > _counter) {
        xh1.classList.add("scanning_xhairs");
        xh1.classList.remove("active_xhairs");
        xh2.classList.add("scanning_xhairs");
        xh2.classList.remove("active_xhairs");
      }
      else { // inactive
        xh1.classList.remove("active_xhairs");
        xh1.classList.remove("scanning_xhairs");
        xh2.classList.remove("active_xhairs");
        xh2.classList.remove("scanning_xhairs");
      }
    },

    render_progress: function (report) {
      console.log("progress!!!!" + report);
      Recv.set_HTML("tdec", "progress " + report);
      const progress_container = document.getElementById('progress_bars');
      const query = '#progress_bars > div[class="progress"]';
      const prev = document.querySelectorAll(query);

      if (!prev || prev.length < report.length) {
        for (var i = (prev ? prev.length : 0); i < report.length; i++) {
          var aaa = document.createElement('div');
          aaa.classList.add("progress");
          progress_container.appendChild(aaa);
        }
      }
      else if (report.length < prev.length) {
        for (var i = report.length; i < prev.length; i++) {
          prev[i].remove();
        }
      }

      const current = document.querySelectorAll(query);
      if (current) {
        console.log(current.length);
      }
      for (var i = 0; i < report.length; i++) {
        console.log(report[i] * 100 + "%");
        current[i].style.width = report[i] * 100 + "%";
      }
    },

    toggleFullscreen: function () {
      _toggleFullscreen();
    },

    showDebug: function () {
      document.getElementById("debug-button").focus();
    },

    clickNav: function () {
      document.getElementById("nav-button").focus();
    },

    blurNav: function (pause) {
      if (pause === undefined) {
        pause = true;
      }
      document.getElementById("nav-button").blur();
      document.getElementById("nav-content").blur();
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

      // configure wasm in main thread
      _mode = modeVal;
      if (_mode > 0) {
        Module._cimbard_configure_decode(_mode);
        Sink.allocate();
      }

      // update ui
      if (_mode > 0) {
        var nav = document.getElementById("mode-val");
        nav.innerHTML = modeToString[_mode];
      }

      var nav = document.getElementById("nav-container");
      if (_mode == 0) {
        nav.classList.add("mode-auto");
        nav.classList.remove("mode-b");
      } else {
        nav.classList.add("mode-b");
        nav.classList.remove("mode-auto");
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
