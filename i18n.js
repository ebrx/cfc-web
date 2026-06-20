// Minimal shared language state for CFC web (zh / en).
// Choice persists in localStorage and is shared across pages; first visit
// follows the browser language. Any `.lang-toggle button[data-lang]` pill on
// the page is auto-wired (active state + click handler optional via onclick).
var CFCLang = (function () {
  function detect() {
    var s;
    try { s = localStorage.getItem('cfcLang'); } catch (e) {}
    if (s === 'zh' || s === 'en') return s;
    return /^zh/i.test(navigator.language || navigator.userLanguage || '') ? 'zh' : 'en';
  }

  var _cur = detect();
  var _subs = [];
  document.documentElement.lang = (_cur === 'zh') ? 'zh-CN' : 'en';

  function _emit() {
    document.documentElement.lang = (_cur === 'zh') ? 'zh-CN' : 'en';
    for (var i = 0; i < _subs.length; i++) {
      try { _subs[i](_cur); } catch (e) { console.error(e); }
    }
  }

  var api = {
    get: function () { return _cur; },
    set: function (l) {
      if (l !== 'zh' && l !== 'en') return;
      _cur = l;
      try { localStorage.setItem('cfcLang', l); } catch (e) {}
      _emit();
    },
    toggle: function () { api.set(_cur === 'zh' ? 'en' : 'zh'); },
    // fn is called immediately with the current language, then on every change
    onChange: function (fn) { _subs.push(fn); try { fn(_cur); } catch (e) { console.error(e); } }
  };

  function wirePill() {
    var btns = document.querySelectorAll('.lang-toggle button[data-lang]');
    if (!btns.length) return;
    api.onChange(function (l) {
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-lang') === l);
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePill);
  } else {
    wirePill();
  }

  return api;
})();
