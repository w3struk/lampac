(function () {
  'use strict';

  if (window.telegram_auth_gate_loaded) return;
  window.telegram_auth_gate_loaded = true;

  var CONFIG = {
    botUsername: '{botUsername}',
    serviceName: '{serviceName}',
    lsUidKey: 'lampac_unic_id',
    lsUserKey: 'tg_auth_user',
    checkIntervalMs: 10000,
    statusTimeoutMs: 8000,
    successOverlayMs: 1600,
    testaccsdbTpl: '{localhost}/testaccsdb',
    footerLines: [
      'Почти внутри — остался один шаг',
      'Сейчас впустим тебя внутрь'
    ]
  };

  var ORIGIN = location.protocol + '//' + location.host;
  var STATUS_URL = ORIGIN + '/tg/auth/status';
  var DEVICE_NAME_URL = ORIGIN + '/tg/auth/device/name';

  var overlay = null;
  var pollTimer = null;
  var authorized = false;
  var accsNetwork = new Lampa.Reguest();
  var accsdbAuthHint = '';

  // Детект TV: Android TV, Tizen, webOS, Orsay, NetCast — через
  // Lampa.Platform + UA-маркеры. Используется для TV-режима
  // (QR-first, без кнопки открытия клиента).
  function isTV() {
    try {
      var pl = typeof Lampa !== 'undefined' ? Lampa.Platform : null;
      if (pl && typeof pl.is === 'function') {
        var tvTags = ['tizen', 'webos', 'webos_land', 'orsay', 'netcast', 'apple_tv', 'apple_tv_gtv'];
        for (var i = 0; i < tvTags.length; i++) {
          try {
            if (pl.is(tvTags[i])) return true;
          } catch (e) { }
        }
      }
    } catch (e2) { }
    var ua = '';
    try {
      ua = navigator.userAgent || '';
    } catch (e3) { }
    if (/Android TV|AndroidTV|\bATV\b|BRAVIA|AFTM|AFTB|AFTT|AFTSS|AFTS|MiTV|PHILIPSTV|HisenseTV|SmartTV|Tizen|Web0S|webOS|SmartHub|\bMaple\b|Opera TV|HbbTV|tvOS|AppleTV|Chromecast|\bCrKey\b/i.test(ua)) return true;
    // Стоковый WebView TV-боксов себя как TV не маркирует
    // (KP1: "Linux; Android 14; KP1 Build/…; wv"). Эвристика: Android +
    // ноль тач-поинтов + большой экран. Только maxTouchPoints отражает
    // железо: 'ontouchstart' in window истинно на любом Android
    // (наличие API, а не тачскрина). Без свойства — консервативно не TV.
    var noTouch = false;
    try {
      noTouch = ('maxTouchPoints' in navigator) && !(navigator.maxTouchPoints > 0);
    } catch (e4) { }
    var bigScreen = false;
    try {
      // Порог 600 CSS-px: 720p при density 320 даёт viewport 640 — такие TV
      // тоже должны попадать в TV-режим. Тач-чек остаётся главным гардом.
      bigScreen = Math.max(screen.width || 0, screen.height || 0) >= 600;
    } catch (e5) { }
    return /Android/i.test(ua) && noTouch && bigScreen;
  }

  function accsdbUrl() {
    var tpl = CONFIG.testaccsdbTpl;
    return tpl.indexOf('{') >= 0 ? ORIGIN + '/testaccsdb' : tpl;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Тексты гейта (ru/en). Английские формулировки — по утверждённым макетам,
  // русские — их прямые эквиваленты. Выбор — по языку Lampa, иначе язык браузера.
  var LANG = {
    en: {
      title: 'Log in with Telegram',
      sub: 'Securely access your account using your Telegram profile.',
      s1lead: 'Tap below to open Telegram.',
      s1sub: 'Your client will launch.',
      s2lead: 'Confirm the login in your Telegram app.',
      s2sub: 'This screen will update automatically.',
      d1: 'Tap the button to open Telegram',
      d2: 'Confirm the login in the app',
      open: 'Open Telegram',
      openDesktop: 'Open Telegram Desktop',
      qrCap: 'Scan with your phone\u2019s camera app',
      okTitle: 'Logged in successfully',
      okUser: 'confirmed via Telegram',
      okNote: 'This screen will close automatically.',
      unav1: 'Telegram login is temporarily unavailable.',
      unav2: 'Contact your server administrator.'
    },
    ru: {
      title: 'Вход через Telegram',
      sub: 'Безопасно войди, используя свой профиль Telegram.',
      s1lead: 'Нажми кнопку ниже, чтобы открыть Telegram.',
      s1sub: 'Твой Telegram-клиент откроется.',
      s2lead: 'Подтверди вход в приложении Telegram.',
      s2sub: 'Этот экран обновится автоматически.',
      d1: 'Нажми кнопку, чтобы открыть Telegram',
      d2: 'Подтверди вход в приложении',
      open: 'Открыть Telegram',
      openDesktop: 'Открыть Telegram Desktop',
      qrCap: 'Отсканируй камерой телефона',
      okTitle: 'Вход выполнен',
      okUser: 'подтверждён через Telegram',
      okNote: 'Экран закроется автоматически.',
      unav1: 'Авторизация через Telegram временно недоступна.',
      unav2: 'Обратись к администратору сервера.'
    }
  };

  function currentLang() {
    var l = '';
    try {
      l = String(Lampa.Storage.get('language', '') || '');
    } catch (e) { }
    if (!l) {
      try {
        l = String(navigator.language || '');
      } catch (e2) { }
    }
    return l.toLowerCase().indexOf('en') === 0 ? 'en' : 'ru';
  }

  function t(k) {
    var L = LANG[currentLang()] || LANG.ru;
    return (L && L[k]) || LANG.en[k] || k;
  }

  // Инлайн-SVG гейта (все размеры задаются в CSS — глобальный svg{width:100%}
  // ядра Lampa перебивает атрибуты width/height).
  // Настоящий знак Lampa (как в widgets/lg/app/img/logo-icon.svg): размеры задаются в CSS.
  var SVG_LOGO = '<svg viewBox="0 0 110 104" aria-hidden="true"><path d="M81.6744 103.11C98.5682 93.7234 110 75.6967 110 55C110 24.6243 85.3757 0 55 0C24.6243 0 0 24.6243 0 55C0 75.6967 11.4318 93.7234 28.3255 103.11C14.8869 94.3724 6 79.224 6 62C6 34.938 27.938 13 55 13C82.062 13 104 34.938 104 62C104 79.224 95.1131 94.3725 81.6744 103.11Z" fill="white"/><path d="M92.9546 80.0076C95.5485 74.5501 97 68.4446 97 62C97 38.804 78.196 20 55 20C31.804 20 13 38.804 13 62C13 68.4446 14.4515 74.5501 17.0454 80.0076C16.3618 77.1161 16 74.1003 16 71C16 49.4609 33.4609 32 55 32C76.5391 32 94 49.4609 94 71C94 74.1003 93.6382 77.1161 92.9546 80.0076Z" fill="white"/><path d="M55 89C69.3594 89 81 77.3594 81 63C81 57.9297 79.5486 53.1983 77.0387 49.1987C82.579 54.7989 86 62.5 86 71C86 88.1208 72.1208 102 55 102C37.8792 102 24 88.1208 24 71C24 62.5 27.421 54.7989 32.9613 49.1987C30.4514 53.1983 29 57.9297 29 63C29 77.3594 40.6406 89 55 89Z" fill="white"/><path d="M73 63C73 72.9411 64.9411 81 55 81C45.0589 81 37 72.9411 37 63C37 53.0589 45.0589 45 55 45C64.9411 45 73 53.0589 73 63Z" fill="white"/></svg>';
  var SVG_PLANE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  var SVG_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

  function getUID() {
    var uid = '';
    try {
      uid = Lampa.Storage.get(CONFIG.lsUidKey, '');
    } catch (e) { }

    if (!uid) {
      uid = Math.random().toString(36).slice(2, 10).toLowerCase();
      try {
        Lampa.Storage.set(CONFIG.lsUidKey, uid);
      } catch (e2) { }
    }

    return uid;
  }

  function applyServerNewUid(res) {
    if (!res || !res.newuid) return;
    var id = Lampa.Utils.uid(8).toLowerCase();
    try {
      Lampa.Storage.set(CONFIG.lsUidKey, id);
    } catch (e) { }
  }

  function truncateDeviceLabel(s, maxLen) {
    maxLen = maxLen || 200;
    s = String(s).replace(/\s+/g, ' ').trim();
    if (s.length > maxLen) return s.slice(0, maxLen - 3) + '...';
    return s;
  }

  function pushDeviceSegment(segments, raw) {
    if (raw == null) return;
    var s = String(raw).replace(/\s+/g, ' ').trim();
    if (!s || s.length > 160) return;
    var low = s.toLowerCase();
    for (var i = 0; i < segments.length; i++) {
      var e = segments[i];
      var el = e.toLowerCase();
      if (el === low) return;
      if (el.indexOf(low) !== -1) return;
      if (low.indexOf(el) !== -1) {
        segments[i] = s;
        return;
      }
    }
    segments.push(s);
  }

  function compactUaDeviceHint(ua) {
    if (!ua) return '';
    if (/SMART-TV|Tizen/i.test(ua)) return 'Tizen TV';
    if (/Web0S|webOS/i.test(ua)) return 'webOS TV';
    if (/Android TV|AndroidTV|ATV|BRAVIA|AFTM|AFTB|AFTT|AFTSS|AFTS|MiTV|PHILIPSTV|HisenseTV|SmartTV/i.test(ua)) return 'Android TV';
    if (/\bCrKey\b|Chromecast/i.test(ua)) return 'Chromecast';
    if (/AppleTV|Apple TV|tvOS/i.test(ua)) return 'Apple TV';
    if (/SmartHub|Maple/i.test(ua)) return 'Samsung Smart TV';
    if (/Opera TV|HbbTV/i.test(ua)) return 'HbbTV / Opera TV';
    var m = ua.match(/\(([^)]+)\)/);
    if (m) {
      var inner = m[1].replace(/\s+/g, ' ').trim();
      var parts = inner.split(';').map(function (x) { return x.trim(); }).filter(Boolean);
      inner = parts.slice(0, 4).join(' · ');
      return truncateDeviceLabel(inner, 120);
    }
    return truncateDeviceLabel(ua, 120);
  }

  function clientBrandsHint() {
    try {
      var uad = navigator.userAgentData;
      if (!uad || !uad.brands || !uad.brands.length) return '';
      var skip = /^Not.A.Brand$/i;
      var names = [];
      for (var i = 0; i < uad.brands.length; i++) {
        var b = uad.brands[i];
        if (!b || !b.brand || skip.test(b.brand)) continue;
        names.push(b.brand);
        if (names.length >= 2) break;
      }
      return names.join(' / ');
    } catch (e) {
      return '';
    }
  }

  function getDeviceDisplayName() {
    var segments = [];
    var ua = navigator.userAgent || '';

    try {
      var pl = typeof Lampa !== 'undefined' ? Lampa.Platform : null;
      if (pl) {
        if (typeof pl.vendor === 'function') {
          try {
            pushDeviceSegment(segments, pl.vendor());
          } catch (e1) { }
        }
        if (typeof pl.screen === 'string') pushDeviceSegment(segments, pl.screen);

        if (typeof pl.is === 'function') {
          var platformTags = [
            ['apple_tv_gtv', 'Apple TV'],
            ['apple_tv', 'Apple TV'],
            ['tizen', 'Tizen'],
            ['webos', 'webOS'],
            ['webos_land', 'webOS'],
            ['android', 'Android'],
            ['orsay', 'Samsung Orsay'],
            ['netcast', 'LG NetCast'],
            ['nw', 'NW.js'],
            ['electron', 'Electron'],
            ['browser', 'Browser']
          ];
          for (var j = 0; j < platformTags.length; j++) {
            try {
              if (pl.is(platformTags[j][0])) {
                pushDeviceSegment(segments, platformTags[j][1]);
                break;
              }
            } catch (e2) { }
          }
        }
      }
    } catch (e) { }

    if (segments.length === 0) {
      pushDeviceSegment(segments, compactUaDeviceHint(ua));
    } else {
      var isBrowser = false;
      try {
        isBrowser = typeof Lampa !== 'undefined' && Lampa.Platform && typeof Lampa.Platform.is === 'function' && Lampa.Platform.is('browser');
      } catch (e3) { }
      if (isBrowser) {
        pushDeviceSegment(segments, clientBrandsHint());
        if (segments.length < 3) pushDeviceSegment(segments, compactUaDeviceHint(ua));
      }
    }

    var label = segments.join(' · ');
    if (!label.trim()) label = 'Web';
    return truncateDeviceLabel(label, 200);
  }

  function postDeviceDisplayName(uid) {
    if (!uid) return;
    var label = getDeviceDisplayName();
    var body = JSON.stringify({ uid: uid, name: label });

    function sendOnce() {
      if (typeof fetch === 'function') {
        fetch(DEVICE_NAME_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body,
          credentials: 'same-origin'
        }).catch(function () { });
        return;
      }
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', DEVICE_NAME_URL, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body);
      } catch (e) { }
    }

    sendOnce();
    setTimeout(sendOnce, 600);
  }

  function requestStatus(uid, onSuccess, onError) {
    var network = new Lampa.Reguest();
    network.silent(
      STATUS_URL + '?uid=' + encodeURIComponent(uid),
      function (result) {
        onSuccess(result || {});
      },
      function (err) {
        if (onError) onError(err || {});
      },
      false,
      { timeout: CONFIG.statusTimeoutMs }
    );
  }

  function ensureStyle() {
    if (document.getElementById('tg-auth-gate-style')) return;

    var style = document.createElement('style');
    style.id = 'tg-auth-gate-style';
    style.textContent =
      'body.tg-auth-gate-lock>*:not(#tg-auth-gate-overlay):not(#tg-auth-gate-style){filter:blur(4px);pointer-events:none!important;user-select:none!important;}' +
      '#tg-auth-gate-overlay{position:fixed;inset:0;z-index:999999;display:flex;padding:20px;box-sizing:border-box;overflow-y:auto;background:#0a0a0d;background-image:radial-gradient(640px 340px at 50% -80px,rgba(47,155,227,.12),rgba(47,155,227,0) 70%);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif;color:#fff;-webkit-font-smoothing:antialiased;}' +
      '.tga-shell{margin:auto;width:100%;display:flex;justify-content:center;}' +
      '.tga-card{width:min(400px,100%);background:#1c1c1f;border:1px solid rgba(255,255,255,.07);border-radius:30px;padding:26px 24px 20px;box-sizing:border-box;box-shadow:0 30px 80px rgba(0,0,0,.55);animation:tga-in .35s ease;}' +
      '@keyframes tga-in{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}' +
      '.tga-brand{display:flex;align-items:center;gap:.55em;margin-bottom:1.15em;}' +
      '.tga-brand svg{width:26px;height:26px;flex:0 0 auto;display:block;}' +
      '.tga-brand span{font-size:15px;font-weight:600;color:#b9b9c0;}' +
      '.tga-title{font-size:27px;font-weight:800;letter-spacing:-.01em;line-height:1.15;margin:0 0 .32em;}' +
      '.tga-sub{font-size:15px;line-height:1.45;color:#9c9ca4;margin:0 0 1.25em;}' +
      '.tga-steps{margin:0 0 1.9em;padding:0;}' +
      '.tga-steps--plain{display:none;}' +
      '.tga-step{display:flex;gap:.8em;}' +
      '.tga-rail{display:flex;flex-direction:column;align-items:center;align-self:stretch;}' +
      '.tga-tile{width:46px;height:46px;flex:0 0 auto;border-radius:13px;background:#2f9be3;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(47,155,227,.35);}' +
      '.tga-tile svg{width:24px;height:24px;display:block;}' +
      '.tga-line{width:2px;flex:1 0 auto;min-height:12px;background:rgba(255,255,255,.12);margin:6px 0;border-radius:2px;}' +
      '.tga-step:last-child .tga-line{display:none;}' +
      '.tga-steptext{padding-top:3px;}' +
      '.tga-lead{font-size:15px;font-weight:700;line-height:1.35;}' +
      '.tga-sub2{font-size:14px;line-height:1.4;color:#9c9ca4;}' +
      '.tga-unav{font-size:14.5px;line-height:1.5;color:#9c9ca4;}' +
      '.tga-actions{display:grid;gap:.7em;margin:0 0 .95em;}' +
      '.tga-btn{display:flex;align-items:center;justify-content:center;gap:.5em;min-height:52px;padding:.8em 1.2em;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;border:0;box-sizing:border-box;color:#fff;text-decoration:none;}' +
      '.tga-btn svg{width:22px;height:22px;flex:0 0 auto;display:block;}' +
      '.tga-btn--primary{background:#2f9be3;box-shadow:0 6px 20px rgba(47,155,227,.35);}' +
      '.tga-btn--primary:hover{background:#2589cc;}' +
      '.tga-btn--secondary{background:#2e2e33;}' +
      '.tga-btn--secondary:hover{background:#38383e;}' +
      '.tga-btn--sm{min-height:44px;font-size:14px;border-radius:12px;}' +
      '.tga-btn.focus,.tga-btn:focus-visible,.tga-btn:focus{outline:none;box-shadow:0 0 0 3px rgba(47,155,227,.6);}' +
      '.tga-only-desk{display:none;}' +
      '.tga-uid{text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;letter-spacing:.08em;color:#8e8e96;margin:0 0 .9em;}' +
      '#tg-auth-progress{display:block;height:4px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;}' +
      '.tg-auth-gate__progress-fill{display:block;width:40%;height:100%;border-radius:inherit;background:#2f9be3;animation:tga-slide 1.6s ease-in-out infinite;}' +
      '@keyframes tga-slide{0%{transform:translateX(-110%);}100%{transform:translateX(280%);}}' +
      '.tga-meta{font-size:12px;color:#6e6e76;text-align:center;margin-top:.4em;}' +
      '.tga-side{display:none;}' +
      '.tga-ok{display:flex;flex-direction:column;align-items:center;text-align:center;padding:.6em 0 .2em;}' +
      '.tga-badge{width:64px;height:64px;border-radius:50%;background:#22c07a;display:flex;align-items:center;justify-content:center;margin-bottom:1em;box-shadow:0 8px 24px rgba(34,192,122,.4);}' +
      '.tga-badge svg{width:30px;height:30px;display:block;}' +
      '.tga-oktitle{font-size:20px;font-weight:800;margin-bottom:.4em;}' +
      '.tga-okuser{font-size:15px;color:#d6dae2;margin-bottom:.4em;word-break:break-all;}' +
      '.tga-oknote{font-size:13.5px;color:#9c9ca4;}' +
      '@media (min-width:700px){' +
      '.tga-card{width:min(620px,100%);background:#17171b;border-radius:24px;padding:36px 40px 28px;}' +
      '.tga-brand{justify-content:center;margin-bottom:1.7em;}' +
      '.tga-brand svg{width:32px;height:32px;}' +
      '.tga-brand span{font-size:22px;font-weight:700;color:#fff;}' +
      '.tga-body{display:grid;grid-template-columns:minmax(0,1fr) 210px;}' +
      '.tga-main{padding-right:32px;min-width:0;}' +
      '.tga-side{display:flex;flex-direction:column;align-items:center;justify-content:center;border-left:1px solid rgba(255,255,255,.08);padding-left:32px;}' +
      '.tga-title{font-size:22px;}' +
      '.tga-sub{font-size:14px;margin-bottom:1.1em;}' +
      '.tga-steps--timeline{display:none;}' +
      '.tga-steps--plain{display:grid;gap:.5em;margin-bottom:1.4em;}' +
      '.tga-pstep{font-size:15px;color:#9c9ca4;}' +
      '.tga-pstep b{color:#fff;font-weight:600;margin-right:.3em;}' +
      '.tga-actions{display:flex;flex-wrap:wrap;}' +
      '.tga-uid{text-align:left;margin:.95em 0 0;}' +
      '.tga-qr{background:#fff;border-radius:16px;padding:12px;width:100%;box-sizing:border-box;}' +
      '.tga-qr img{width:100%;height:auto;display:block;border-radius:6px;aspect-ratio:1/1;}' +
      '.tga-qrcap{font-size:13px;line-height:1.4;color:#9c9ca4;text-align:center;margin-top:.9em;}' +
      '.tga-meta{text-align:left;}' +
      '.tga-only-desk{display:inline;}' +
      '.tga-only-mob{display:none;}' +
      '}' +
      '@media (prefers-reduced-motion:reduce){.tga-card{animation:none;}.tg-auth-gate__progress-fill{animation:none;width:60%;}}' +
      'body.tga-tv #tg-auth-gate-overlay{padding:10px;}' +
      'body.tga-tv .tga-card{width:min(480px,100%);padding:14px 20px 12px;}' +
      'body.tga-tv .tga-brand{justify-content:center;margin-bottom:.5em;}' +
      'body.tga-tv .tga-brand svg{width:22px;height:22px;}' +
      'body.tga-tv .tga-brand span{font-size:16px;font-weight:700;color:#fff;}' +
      'body.tga-tv .tga-body{display:flex;flex-direction:column;}' +
      'body.tga-tv .tga-main{display:contents;}' +
      'body.tga-tv .tga-title{order:1;font-size:24px;text-align:center;}' +
      'body.tga-tv .tga-sub{order:2;font-size:13px;text-align:center;margin-bottom:.8em;}' +
      'body.tga-tv .tga-side{order:3;display:flex;border-left:0;padding-left:0;margin-bottom:.8em;}' +
      'body.tga-tv .tga-steps--timeline{display:none;}' +
      'body.tga-tv .tga-steps--plain{display:grid;order:4;gap:.4em;max-width:400px;width:100%;margin-left:auto;margin-right:auto;margin-bottom:1em;}' +
      'body.tga-tv .tga-pstep{font-size:15px;}' +
      'body.tga-tv .tga-uid{order:5;font-size:12px;text-align:center;margin:.7em 0;}' +
      'body.tga-tv .tga-actions{order:7;justify-content:center;margin-bottom:0;}' +
      'body.tga-tv .tga-actions .tga-btn{min-height:44px;font-size:15px;padding:.7em 1.8em;}' +
      'body.tga-tv #tg-auth-progress{order:6;}' +
      'body.tga-tv .tga-meta{display:none;}' +
      'body.tga-tv .tga-qr{max-width:160px;padding:10px;margin-left:auto;margin-right:auto;}' +
      'body.tga-tv .tga-qrcap{display:none;}';
    document.body.appendChild(style);
  }

  function removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function lockApp() {
    document.body.classList.add('tg-auth-gate-lock');
  }

  /** Сброс стека Lampa и переход на главную (как после успешного пароля в deny.js). */
  function reloadToMainPage() {
    try {
      localStorage.removeItem('activity');
    } catch (e) { }
    try {
      var u = new URL(window.location.href);
      u.search = '';
      u.hash = '';
      window.location.replace(u.origin + u.pathname);
    } catch (e2) {
      try {
        window.location.replace('/');
      } catch (e3) { }
    }
  }

  function unlockApp() {
    authorized = true;
    stopPolling();
    removeOverlay();
    document.body.classList.remove('tg-auth-gate-lock');
    try {
      document.body.classList.remove('tga-tv');
    } catch (e) { }
    try {
      delete window.start_deep_link;
    } catch (e) { }
    try {
      window.sync_disable = false;
    } catch (e) { }
    var appEl = document.getElementById('app');
    if (appEl) appEl.style.display = '';
    reloadToMainPage();
  }

  function serviceLabel() {
    return escapeHtml(CONFIG.serviceName);
  }

  function showSuccessOverlay(result) {
    ensureStyle();
    removeOverlay();

    var uname = escapeHtml((result && result.username) || '');
    overlay = document.createElement('div');
    overlay.id = 'tg-auth-gate-overlay';
    overlay.innerHTML =
      '<div class="tga-shell">' +
      '<div class="tga-card">' +
      '<div class="tga-brand">' + SVG_LOGO + '<span>Lampa Auth</span></div>' +
      '<div class="tga-ok">' +
      '<div class="tga-badge">' + SVG_CHECK + '</div>' +
      '<div class="tga-oktitle">' + escapeHtml(t('okTitle')) + '</div>' +
      '<div class="tga-okuser">@' + uname + ' · ' + escapeHtml(t('okUser')) + '</div>' +
      '<div class="tga-oknote">' + escapeHtml(t('okNote')) + '</div>' +
      '</div>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);
  }

  function buildOverlay(uid, message) {
    ensureStyle();
    removeOverlay();

    var bot = CONFIG.botUsername.replace(/^@/, '');
    var hasBot = !!bot && bot.indexOf('{') === -1;
    var tgUrl = '';
    var qrUrl = '';
    if (hasBot) {
      tgUrl = 'https://t.me/' + encodeURIComponent(bot) + '?start=' + encodeURIComponent(uid);
      qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(tgUrl);
    }
    var footArr = CONFIG.footerLines;
    var footerMessage = footArr.length ? footArr[Math.floor(Math.random() * footArr.length)] : '';
    var msgHtml = escapeHtml(message || '');

    var isTVMode = isTV();
    try {
      document.body.classList.toggle('tga-tv', isTVMode);
    } catch (e) { }

    // Шаги: мобайл — таймлайн с плитками-иконками (по макету), десктоп —
    // нумерованный список. Деградация !hasBot — текстовый блок без шагов.
    var unavHtml = '<div class="tga-unav">' + escapeHtml(t('unav1')) + ' ' + escapeHtml(t('unav2')) + '</div>';
    var stepsTimelineHtml = hasBot
      ? '<div class="tga-steps tga-steps--timeline">' +
        '<div class="tga-step"><div class="tga-rail"><div class="tga-tile">' + SVG_PLANE + '</div><div class="tga-line"></div></div><div class="tga-steptext"><div class="tga-lead">' + escapeHtml(t('s1lead')) + '</div><div class="tga-sub2">' + escapeHtml(t('s1sub')) + '</div></div></div>' +
        '<div class="tga-step"><div class="tga-rail"><div class="tga-tile">' + SVG_CHECK + '</div><div class="tga-line"></div></div><div class="tga-steptext"><div class="tga-lead">' + escapeHtml(t('s2lead')) + '</div><div class="tga-sub2">' + escapeHtml(t('s2sub')) + '</div></div></div>' +
        '</div>'
      : '<div class="tga-steps tga-steps--timeline">' + unavHtml + '</div>';
    // Кнопка Refresh удалена целиком (polling + Noty покрывают флоу);
    // actions-блок рендерится только если есть хоть одна кнопка.
    var openHtml = (hasBot && !isTVMode)
      ? '<div class="tga-btn tga-btn--primary selector" id="tg-auth-gate-open" tabindex="0" role="button">' + SVG_PLANE + '<span class="tga-only-mob">' + escapeHtml(t('open')) + '</span><span class="tga-only-desk">' + escapeHtml(t('openDesktop')) + '</span></div>'
      : '';
    var stepsPlainHtml = hasBot
      ? '<div class="tga-steps tga-steps--plain">' +
        '<div class="tga-pstep"><b>1.</b>' + escapeHtml(isTVMode ? t('qrCap') : t('d1')) + '</div>' +
        '<div class="tga-pstep"><b>2.</b>' + escapeHtml(t('d2')) + '</div>' +
        '</div>'
      : '<div class="tga-steps tga-steps--plain">' + unavHtml + '</div>';

    overlay = document.createElement('div');
    overlay.id = 'tg-auth-gate-overlay';
    overlay.innerHTML =
      '<div class="tga-shell">' +
      '<div class="tga-card">' +
      '<div class="tga-brand">' + SVG_LOGO + '<span>Lampa Auth</span></div>' +
      '<div class="tga-body"><div class="tga-main">' +
      '<div class="tga-title">' + escapeHtml(t('title')) + '</div>' +
      '<div class="tga-sub">' + (msgHtml || escapeHtml(t('sub'))) + '</div>' +
      stepsTimelineHtml + stepsPlainHtml +
      (openHtml ? '<div class="tga-actions">' + openHtml + '</div>' : '') +
      '<div class="tga-uid">UID: ' + escapeHtml(uid) + '</div>' +
      '<div id="tg-auth-progress"><span class="tg-auth-gate__progress-fill"></span></div>' +
      (footerMessage ? '<div class="tga-meta">' + escapeHtml(footerMessage) + '</div>' : '') +
      '</div>' +
      (hasBot ? '<div class="tga-side"><div class="tga-qr"><img src="' + escapeHtml(qrUrl) + '" alt="Telegram QR"></div><div class="tga-qrcap">' + escapeHtml(t('qrCap')) + '</div></div>' : '') +
      '</div>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var openBtn = document.getElementById('tg-auth-gate-open');

    if (openBtn) {
      openBtn.addEventListener('click', function () {
        // uid свежий на момент клика (applyServerNewUid мог сменить storage)
        // Прямая навигация по схеме: клиент открывает приложение, не выгружая страницу;
        // iframe-метод заблокирован современным Chrome для cross-origin фреймов.
        var freshUid = getUID();
        location.href = 'tg://resolve?domain=' + encodeURIComponent(bot) + '&start=' + encodeURIComponent(freshUid);
      });
    }

    // Refresh удалён: мгновенная перепроверка больше недоступна,
    // polling каждые 10с и Noty покрывают флоу.
    // TV: кнопок не осталось (Open скрыт) — фокусить нечего,
    // QR-флоу полностью на polling; D-pad-навигации не требуется.

    // Div-кнопки с tabindex фокусируются пультом/клавиатурой, но Enter по ним
    // не стреляет click сам (как у <button>). Дублируем активацию клавишами,
    // с keyCode-фолбэком для старых TV WebView без современного ev.key.
    function armKeyActivation(btn) {
      if (!btn) return;
      btn.addEventListener('keydown', function (ev) {
        var k = ev.key;
        var kc = ev.keyCode;
        if (k === 'Enter' || kc === 13 || k === ' ' || k === 'Spacebar' || kc === 32) {
          try {
            ev.preventDefault();
          } catch (e) { }
          try {
            btn.click();
          } catch (e2) { }
        }
      });
    }
    armKeyActivation(openBtn);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!authorized) checkAccess(false);
    }, CONFIG.checkIntervalMs);
  }

  function handleAuthorized(uid, result) {
    postDeviceDisplayName(uid);

    try {
      Lampa.Storage.set(CONFIG.lsUserKey, {
        telegramId: result.telegramId || '',
        username: result.username || '',
        role: result.role || 'user',
        expiresAt: result.expiresAt || ''
      });
    } catch (e) { }

    showSuccessOverlay(result || {});
    setTimeout(function () {
      unlockApp();
    }, CONFIG.successOverlayMs);
  }

  function handleUnauthorized(uid, result) {
    lockApp();
    var hint =
      (result && result.message) ||
      accsdbAuthHint ||
      'Подтвердите устройство через Telegram-бота.';
    buildOverlay(uid, hint);
    startPolling();
  }

  function checkAccess(forceNotify) {
    var uid = getUID();

    requestStatus(uid, function (result) {
      if (result && result.authorized) {
        handleAuthorized(uid, result);
      } else {
        handleUnauthorized(uid, result);
        if (forceNotify) {
          Lampa.Noty.show((result && result.message) || 'Устройство ещё не авторизовано');
        }
      }
    }, function () {
      handleUnauthorized(uid, { message: 'Не удалось проверить авторизацию. Сервер недоступен.' });
      if (forceNotify) Lampa.Noty.show('Не удалось проверить авторизацию');
    });
  }

  function startGate() {
    checkAccess(false);
  }

  function onAccsdbRequiresAuth(res) {
    // Не выставляем start_deep_link на denypages: ядро Lampa тогда пишет в URL
    // ?component=denypages&page=1 и открывает экран deny; здесь достаточно оверлея и скрытого #app.

    applyServerNewUid(res);

    window.sync_disable = true;
    var appEl = document.getElementById('app');
    if (appEl) appEl.style.display = 'none';

    if (res.denymsg) {
      var pwait = document.createElement('div');
      pwait.id = 'loading-element';
      pwait.style.fontSize = 'xxx-large';
      pwait.style.textAlign = 'center';
      pwait.style.marginTop = '2em';
      pwait.innerHTML = res.denymsg;
      document.body.appendChild(pwait);
      return;
    }

    accsdbAuthHint = res && res.msg ? String(res.msg) : '';
    startGate();
  }

  function buildTestaccsdbRequestUrl() {
    var url = accsdbUrl();
    var email = Lampa.Storage.get('account_email');
    if (email) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
    var uid0 = Lampa.Storage.get(CONFIG.lsUidKey, '');
    if (uid0) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid0));
    url = Lampa.Utils.addUrlComponent(url, 'token={token}');
    return url;
  }

  function checkAutch() {
    accsNetwork.silent(
      buildTestaccsdbRequestUrl(),
      function (res) {
        if (res.accsdb) {
          onAccsdbRequiresAuth(res);
        } else {
          accsNetwork.clear();
          accsNetwork = null;
        }
      },
      function () { }
    );
  }

  function scheduleCheckAutch() {
    if (window.appready) {
      checkAutch();
    } else if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(checkAutch, 500);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(checkAutch, 500);
      });
    }
  }

  scheduleCheckAutch();
})();
