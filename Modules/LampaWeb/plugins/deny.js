(function () {
'use strict';

if (window.deny_accs_gate_loaded) return;
window.deny_accs_gate_loaded = true;

var network = new Lampa.Reguest();
var api = Lampa.Utils.protocol() + Lampa.Manifest.cub_domain + '/api/';

function addDevice(message) {
  var enter_cub = false;

  var displayModal = function displayModal() {
    var html = Lampa.Template.get('account_add_device');

    if (!enter_cub) {

      if (message) {
        html.find('.about').html(message + '<br><br>unic_id: ' + Lampa.Storage.get('lampac_unic_id', ''));
      } else {
        html.find('.about').html('{cubMesage}');
      }

      html.find('.simple-button').remove();
      html.find('.account-add-device__qr').remove();

      var foot = $('<div class="modal__footer"></div>');
      var button_cub = $('<div class="simple-button selector" style="margin: 0.5em;">Аккаунт в CUB</div>');
      var button_cod = $('<div class="simple-button selector" style="margin: 0.5em;">Вход по паролю</div>');

      foot.append(button_cod);
      foot.append(button_cub);

      html.append($('<div>Либо используйте пароль/аккаунт для авторизации</div>'));
      html.append(foot);
	  
	  html.append('<div style="margin-top: 3em; font-size: 1.4em; line-height: 1.3; font-weight: 300;">Инструкция<br>{localhost}/e/acb</div>');
	  
      button_cub.on('hover:enter', function() {
        enter_cub = true;
        Lampa.Modal.close();
        displayModal();
      });

      button_cod.on('hover:enter', function() {
        Lampa.Modal.close();
        Lampa.Input.edit({
          free: true,
          title: Lampa.Lang.translate('Введите пароль'),
          nosave: true,
          value: '',
          //layout: 'nums',
          nomic: true
        }, function(new_value) {
          displayModal();

          var code = new_value;

          if (new_value) {
            Lampa.Loading.start(function() {
              network.clear();
              Lampa.Loading.stop();
            });
            network.clear();

            var u = '{localhost}/testaccsdb';
            u = Lampa.Utils.addUrlComponent(u, 'account_email=' + encodeURIComponent(code));
			
            var uid = Lampa.Storage.get('lampac_unic_id', '');
            if (uid) u = Lampa.Utils.addUrlComponent(u, 'uid=' + encodeURIComponent(uid));

            network.silent(u, function(result) {
              Lampa.Loading.stop();
              if (result.success) {
                if (result.uid) {
                  Lampa.Modal.close();
                  const loadingElement = document.getElementById("loading-element");
                  if (loadingElement) {
                    loadingElement.textContent = "Аккаунт зарегистрирован";
                    loadingElement.style.color = "antiquewhite";
                  }
                  var pwait = document.createElement("div");
					  pwait.style.fontSize = "xx-large";
					  pwait.style.marginTop = "2em";
					  pwait.style.padding = "2em";
					  pwait.innerHTML = 'Сохраните ваш персональный пароль <span style="color: red;">'+result.uid+'</span> для будущих авторизаций на текущем устройстве, а так же для авторизации на других устройствах, все ваши закладки и синхронизация между устройствами происходит через персональный пароль <span style="color: red;">'+result.uid+'</span><br><br><br><br>После сохранения пароля в надежном месте <b style="color: cadetblue;">перезагрузите страницу/приложение</b>';
                  document.body.appendChild(pwait);
                } else {
                  Lampa.Storage.set('lampac_unic_id', code);
                  localStorage.removeItem('activity');
                  window.location.href = '/';
                }
              } else {
                Lampa.Noty.show(Lampa.Lang.translate('Неправильный пароль'));
              }
            }, function() {
              Lampa.Loading.stop();
              Lampa.Noty.show(Lampa.Lang.translate('account_code_error'));
            }, {
              code: code
            });
          } else {
            Lampa.Noty.show(Lampa.Lang.translate('account_code_wrong'));
          }
        });
      });

    } else {
      html.find('.simple-button').on('hover:enter', function() {
        Lampa.Modal.close();
        Lampa.Input.edit({
          free: true,
          title: Lampa.Lang.translate('account_code_enter'),
          nosave: true,
          value: '',
          layout: 'nums',
          nomic: true
        }, function(new_value) {
          displayModal();

          var code = parseInt(new_value);

          if (new_value && new_value.length == 6 && !isNaN(code)) {
            Lampa.Loading.start(function() {
              network.clear();
              Lampa.Loading.stop();
            });
            network.clear();
            network.silent(api + 'device/add', function(result) {
              Lampa.Loading.stop();
              Lampa.Storage.set('account', result, true);
              Lampa.Storage.set('account_email', result.email, true);
			  localStorage.removeItem('activity');
              window.location.href = '/';
            }, function() {
              Lampa.Loading.stop();
              Lampa.Noty.show(Lampa.Lang.translate('account_code_error'));
            }, {
              code: code
            });
          } else {
            Lampa.Noty.show(Lampa.Lang.translate('account_code_wrong'));
          }
        });
      });
    }


    Lampa.Modal.open({
      title: '',
      html: html,
      size: 'full',
      onBack: function onBack() {
        Lampa.Modal.close();
        displayModal();
      }
    });
  };
  displayModal();
}

function checkAutch() {
  var url = '{localhost}/testaccsdb';

  var email = Lampa.Storage.get('account_email');
  if (email) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));

  var uid = Lampa.Storage.get('lampac_unic_id', '');
  if (uid) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));

  var token = '{token}';
  if (token) url = Lampa.Utils.addUrlComponent(url, 'token={token}');

  network.silent(url, function(res) {
    if (res.accsdb) {

      // Deny-экран показан — heartbeat здесь не работает (XOR-инвариант);
      // стоп на случай повторного вызова checkAutch при активном heartbeat.
      stopDenyHeartbeat();

      window.start_deep_link = {
        component: 'denypages',
        page: 1,
        url: ''
      };
  
      if (res.newuid) {
        var unic_id = Lampa.Utils.uid(8).toLowerCase();
        Lampa.Storage.set('lampac_unic_id', unic_id);
      }
  
      window.sync_disable = true;
      document.getElementById("app").style.display = "none";
      var pwait = document.createElement("div");
		  pwait.id = "loading-element";
		  pwait.style.fontSize = "xxx-large";
		  pwait.style.textAlign = "center";
		  pwait.style.marginTop = "2em";
		  pwait.innerHTML = res.denymsg || "please wait";
		  document.body.appendChild(pwait);

      if (!res.denymsg) {
        setTimeout(function() {
          addDevice(res.msg);
        }, 5000);
      }
    } else {
      network.clear();
      // Разблокировано — страница живая: запускаем heartbeat живого ре-чека
      // (read-only проба probe=1, см. ниже). network не зануляем, чтобы
      // поздние network.clear() в addDevice не падали на null.
      startDenyHeartbeat();
    }
  }, function() {
    //setTimeout(checkAutch, 1000 * 3);
    // Ретрай 3 с не возвращаем осознанно: steady-state опрос каждые 3 с от
    // всех клиентов = thundering herd на /testaccsdb. Вместо этого heartbeat
    // ниже: база 60 с + джиттер ±30% (~1 запрос/мин/клиент), backoff ×2 до
    // 5 мин при сетевых ошибках, relock после 2 подряд accsdb:true.
  });
}

// ── Heartbeat живого ре-чека (паритет с telegram_auth_gate.js, Phase 3) ──
// Пока страница разблокирована, периодически проверяем accsdb read-only
// пробой probe=1. Два подряд отказа → denyRelock (та же deny-последовательность,
// что и при загрузке, но без перезагрузки). Сетевые ошибки отказом не считаются
// (fail-open) и дают backoff. Инвариант «heartbeat XOR deny-экран»: heartbeat
// работает ТОЛЬКО разблокированным; при показанном deny-экране стопается.
var DENY_HEARTBEAT_BASE_MS = 60000;
var DENY_HEARTBEAT_JITTER_RATIO = 0.3;
var DENY_HEARTBEAT_BACKOFF_MAX_MS = 300000;
var DENY_HEARTBEAT_WAKE_MIN_MS = 10000;
var DENY_STATUS_TIMEOUT_MS = 8000;

var denyHeartbeatTimer = null;
var denyHeartbeatProbe = null;
var denyHeartbeatInFlight = false;
var denyHeartbeatActive = false;
var denyHeartbeatFails = 0;
var denyHeartbeatBackoffMs = 0;
var denyHeartbeatLastTickAt = 0;
var denyHeartbeatListenersBound = false;
var denyRelocked = false;

function denyCurrentLang() {
  // Паритет с currentLang() в telegram_auth_gate.js: язык Lampa, иначе язык браузера.
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

function buildDenyProbeUrl() {
  var url = '{localhost}/testaccsdb';

  var email = Lampa.Storage.get('account_email');
  if (email) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));

  var uid = Lampa.Storage.get('lampac_unic_id', '');
  if (uid) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));

  url = Lampa.Utils.addUrlComponent(url, 'lang=' + encodeURIComponent(denyCurrentLang()));

  var token = '{token}';
  if (token) url = Lampa.Utils.addUrlComponent(url, 'token={token}');

  url = Lampa.Utils.addUrlComponent(url, 'probe=1');
  return url;
}

function denyRelock(res) {
  // Guard от дублей: повторные тики отказа не плодят #loading-element/модалку.
  if (denyRelocked) return;
  denyRelocked = true;
  stopDenyHeartbeat();

  window.start_deep_link = {
    component: 'denypages',
    page: 1,
    url: ''
  };

  if (res.newuid) {
    var unic_id = Lampa.Utils.uid(8).toLowerCase();
    Lampa.Storage.set('lampac_unic_id', unic_id);
  }

  window.sync_disable = true;
  document.getElementById("app").style.display = "none";
  // #loading-element мог остаться от загрузочной deny-ветки — переиспользуем,
  // а не плодим дубли.
  var pwait = document.getElementById("loading-element");
  if (!pwait) {
    pwait = document.createElement("div");
    pwait.id = "loading-element";
    pwait.style.fontSize = "xxx-large";
    pwait.style.textAlign = "center";
    pwait.style.marginTop = "2em";
    document.body.appendChild(pwait);
  }
  pwait.innerHTML = res.denymsg || "please wait";

  // denymsg-путь — тупик без recovery: показан только статический текст,
  // модалка addDevice не открывается и повторных проб нет (известное
  // ограничение, паритет с reLockAndShowGate в telegram_auth_gate.js —
  // там denymsg-ветка тоже возвращается без оверлея и polling).
  if (!res.denymsg) {
    setTimeout(function() {
      addDevice(res.msg);
    }, 5000);
  }
}

function scheduleNextDenyHeartbeat() {
  if (denyHeartbeatTimer) {
    clearTimeout(denyHeartbeatTimer);
    denyHeartbeatTimer = null;
  }
  var base = denyHeartbeatBackoffMs > 0 ? denyHeartbeatBackoffMs : DENY_HEARTBEAT_BASE_MS;
  var jitter = Math.floor(base * DENY_HEARTBEAT_JITTER_RATIO);
  var delay = base;
  if (jitter > 0) delay = base - jitter + Math.floor(Math.random() * (jitter * 2 + 1));
  if (delay < 1000) delay = 1000;
  denyHeartbeatTimer = setTimeout(denyHeartbeatTick, delay);
}

function denyHeartbeatTick() {
  denyHeartbeatTimer = null;
  if (denyHeartbeatInFlight) {
    // Внеплановая проба уже в полёте — не роняем поток.
    scheduleNextDenyHeartbeat();
    return;
  }

  denyHeartbeatInFlight = true;
  denyHeartbeatLastTickAt = Date.now();

  // Переиспользуем один Reguest на все тики.
  if (!denyHeartbeatProbe) {
    try { denyHeartbeatProbe = new Lampa.Reguest(); } catch (e) { denyHeartbeatProbe = null; }
  }
  if (!denyHeartbeatProbe) {
    denyHeartbeatInFlight = false;
    scheduleNextDenyHeartbeat();
    return;
  }

  try {
    denyHeartbeatProbe.silent(
      buildDenyProbeUrl(),
      function (res) {
        denyHeartbeatInFlight = false;
        // Поздний колбэк после stop (Reguest.clear() не отменяет уже принятый
        // ответ): без активного heartbeat таймер не воскрешаем.
        if (!denyHeartbeatActive || denyRelocked) return;
        if (res && res.accsdb) {
          denyHeartbeatFails++;
          if (denyHeartbeatFails >= 2) {
            // Подтверждение отказа: два подряд — relock без перезагрузки.
            denyRelock(res);
            return;
          }
          // Первый отказ — только счётчик (анти-флап).
          denyHeartbeatBackoffMs = 0;
          scheduleNextDenyHeartbeat();
          return;
        }
        denyHeartbeatFails = 0;
        denyHeartbeatBackoffMs = 0;
        scheduleNextDenyHeartbeat();
      },
      function () {
        // Сетевая ошибка — не отказ: backoff ×2 (потолок 5 мин), без relock.
        denyHeartbeatInFlight = false;
        // Тот же guard, что в success-ветке: поздний колбэк после stop
        // (Reguest.clear()) не должен воскрешать таймер.
        if (!denyHeartbeatActive || denyRelocked) return;
        if (denyHeartbeatBackoffMs > 0) {
          denyHeartbeatBackoffMs = Math.min(denyHeartbeatBackoffMs * 2, DENY_HEARTBEAT_BACKOFF_MAX_MS);
        } else {
          denyHeartbeatBackoffMs = Math.min(DENY_HEARTBEAT_BASE_MS * 2, DENY_HEARTBEAT_BACKOFF_MAX_MS);
        }
        scheduleNextDenyHeartbeat();
      },
      false,
      { timeout: DENY_STATUS_TIMEOUT_MS }
    );
  } catch (e2) {
    // Синхронный throw — не залипаем в inFlight.
    denyHeartbeatInFlight = false;
    scheduleNextDenyHeartbeat();
  }
}

function denyHeartbeatWakeCheck() {
  // Внеплановая проба (visible/focus): только в активном heartbeat, запрос
  // не в полёте и с последнего тика прошло больше дебаунса.
  if (!denyHeartbeatActive || denyRelocked || denyHeartbeatInFlight) return;
  if (Date.now() - denyHeartbeatLastTickAt < DENY_HEARTBEAT_WAKE_MIN_MS) return;
  if (denyHeartbeatTimer) {
    clearTimeout(denyHeartbeatTimer);
    denyHeartbeatTimer = null;
  }
  denyHeartbeatTick();
}

function onDenyHeartbeatVisible() {
  if (document.visibilityState !== 'visible') return;
  denyHeartbeatWakeCheck();
}

function onDenyHeartbeatFocus() {
  denyHeartbeatWakeCheck();
}

function startDenyHeartbeat() {
  // Идемпотентно: второго потока не появится даже при повторном вызове;
  // после relock не перезапускаемся.
  if (denyRelocked) return;
  stopDenyHeartbeat();
  denyHeartbeatActive = true;
  denyHeartbeatLastTickAt = Date.now();
  if (!denyHeartbeatListenersBound) {
    document.addEventListener('visibilitychange', onDenyHeartbeatVisible);
    window.addEventListener('focus', onDenyHeartbeatFocus);
    denyHeartbeatListenersBound = true;
  }
  scheduleNextDenyHeartbeat();
}

function stopDenyHeartbeat() {
  denyHeartbeatActive = false;
  if (denyHeartbeatTimer) {
    clearTimeout(denyHeartbeatTimer);
    denyHeartbeatTimer = null;
  }
  denyHeartbeatInFlight = false;
  denyHeartbeatFails = 0;
  denyHeartbeatBackoffMs = 0;
  if (denyHeartbeatProbe) {
    try { denyHeartbeatProbe.clear(); } catch (e3) { }
    denyHeartbeatProbe = null;
  }
  if (denyHeartbeatListenersBound) {
    document.removeEventListener('visibilitychange', onDenyHeartbeatVisible);
    window.removeEventListener('focus', onDenyHeartbeatFocus);
    denyHeartbeatListenersBound = false;
  }
}

// Уход страницы: гасим таймер и чистим probe-инстанс. Слушатель ставится
// один раз — файл исполняется единожды (см. deny_accs_gate_loaded выше).
window.addEventListener('pagehide', function () {
  stopDenyHeartbeat();
});

checkAutch();
})();