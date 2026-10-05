/**
 * The enrollment page's script (#3257, S2b), served from the consent origin as
 * `script-src 'self'`. Plain browser JavaScript with no dependencies: it only
 * moves bytes between the Station routes and `navigator.credentials.create`,
 * and renders with `textContent` (never `innerHTML`). The server decides
 * everything that matters (origin, RP ID, challenge, user verification); this
 * script cannot weaken any of it.
 */
export const ENROLLMENT_PAGE_SCRIPT = `(function () {
  'use strict';
  var BASE = '/operator/passkeys/enroll/requests';
  var requestId = null;
  var poll = null;
  function $(id) { return document.getElementById(id); }
  function show(name) {
    ['intro', 'waiting', 'create', 'done'].forEach(function (id) {
      $(id).hidden = id !== name;
    });
  }
  function problem(text) {
    var el = $('problem');
    el.textContent = text || '';
    el.hidden = !text;
  }
  function toBuffer(value) {
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    var raw = atob(padded);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }
  function toBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var raw = '';
    for (var i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    return btoa(raw).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function api(path, method, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error(json.message || 'The request failed.');
        return json;
      });
    });
  }
  function stopPolling() { if (poll !== null) { clearInterval(poll); poll = null; } }
  function start() {
    problem('');
    $('start').disabled = true;
    api(BASE, 'POST', {}).then(function (created) {
      requestId = created.requestId;
      $('code').textContent = created.code.slice(0, 3) + ' ' + created.code.slice(3);
      show('waiting');
      poll = setInterval(check, 2000);
    }).catch(function (error) {
      problem(error.message);
    }).then(function () { $('start').disabled = false; });
  }
  function check() {
    api(BASE + '/' + encodeURIComponent(requestId), 'GET').then(function (status) {
      if (status.state === 'confirmed') { stopPolling(); show('create'); }
      else if (status.state !== 'pending') {
        stopPolling();
        show('intro');
        problem('This request is ' + status.state + '. Start again.');
      }
    }).catch(function (error) { stopPolling(); show('intro'); problem(error.message); });
  }
  function make() {
    problem('');
    $('make').disabled = true;
    api(BASE + '/' + encodeURIComponent(requestId) + '/options', 'POST', {}).then(function (options) {
      options.challenge = toBuffer(options.challenge);
      options.user.id = toBuffer(options.user.id);
      (options.excludeCredentials || []).forEach(function (c) { c.id = toBuffer(c.id); });
      return navigator.credentials.create({ publicKey: options });
    }).then(function (credential) {
      if (!credential) throw new Error('No passkey was created.');
      var response = credential.response;
      return api(BASE + '/' + encodeURIComponent(requestId) + '/verify', 'POST', {
        label: $('label').value,
        response: {
          id: credential.id,
          rawId: toBase64Url(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment || undefined,
          clientExtensionResults: credential.getClientExtensionResults(),
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            attestationObject: toBase64Url(response.attestationObject),
            transports: response.getTransports ? response.getTransports() : []
          }
        }
      });
    }).then(function () {
      requestId = null;
      show('done');
    }).catch(function (error) {
      problem(error && error.name === 'NotAllowedError'
        ? 'The passkey prompt was cancelled or timed out. Try again.'
        : (error && error.message) || 'Passkey setup failed.');
    }).then(function () { $('make').disabled = false; });
  }
  $('start').addEventListener('click', start);
  $('make').addEventListener('click', make);
  $('another').addEventListener('click', function () { $('label').value = ''; show('intro'); });
})();
`;
