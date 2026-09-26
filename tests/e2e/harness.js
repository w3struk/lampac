// Harness-страница для тестов гейта: отдаётся через page.route (без правок сервера).
// Реальный /telegram_auth_gate.js и реальный jQuery с сервера, стабы только для Lampa.
function harnessHtml(uid) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>gate harness</title></head><body>' +
    '<div id="app" style="display:block">lampa-stub</div>' +
    '<script>' +
    'window.Lampa = {' +
    '  Storage: { _s: { "lampac_unic_id": "' + uid + '", "language": "ru" },' +
    '    get: function (k, d) { return (k in this._s) ? this._s[k] : (d === undefined ? "" : d); },' +
    '    set: function (k, v) { this._s[k] = v; } },' +
    '  Utils: {' +
    '    uid: function (n) { return Math.random().toString(36).slice(2, 2 + (n || 8)); },' +
    '    addUrlComponent: function (url, comp) { return url + (url.indexOf("?") >= 0 ? "&" : "?") + comp; } },' +
    '  Noty: { show: function (t) { (window.__noty = window.__noty || []).push(String(t)); } },' +
    '  Platform: { is: function () { return false; } },' +
    '  Reguest: null };' +
    'function Reguest() {}' +
    'Reguest.prototype.silent = function (url, ok, err, post) {' +
    '  fetch(url, { method: post ? "POST" : "GET", body: post || null })' +
    '    .then(function (r) { return r.json(); })' +
    '    .then(function (j) { if (ok) ok(j); })' +
    '    .catch(function () { if (err) err({}); });' +
    '};' +
    'Reguest.prototype.clear = function () {};' +
    'window.Lampa.Reguest = Reguest;' +
    'window.__bootT = performance.timeOrigin;' +
    '</script>' +
    '<script src="/lampa-main/vender/jquery/jquery.js"></script>' +
    '<script src="/telegram_auth_gate.js"></script>' +
    '</body></html>';
}

module.exports = { harnessHtml };
