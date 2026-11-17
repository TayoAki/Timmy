/*
 * Timmy website chat: the loader a business pastes into its own website.
 *
 *   <script src="https://…/chat.js" data-site="SITE-KEY" async></script>
 *
 * It does one thing: it adds a frame, in the corner of the page, that holds the chat. The chat itself runs
 * inside that frame, on Timmy's own address, so this page and the chat cannot read or change each other.
 * The only thing the frame may ask of this page is to show it hidden, as a bubble, or as an open window.
 * Written in plain old JavaScript with no dependencies, so it runs on any website as it is.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__timmyChat) return;
  var site = script.getAttribute('data-site') || '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(site)) return;
  var origin;
  try {
    origin = new URL(script.src, location.href).origin;
  } catch (e) {
    return;
  }
  window.__timmyChat = true;

  // The three ways the frame can be shown. The frame names one of them; it never sends sizes or styles.
  var PLACE = 'position:fixed;right:0;bottom:0;border:0;margin:0;padding:0;z-index:2147483000;background:transparent;color-scheme:normal;max-width:100vw;max-height:100vh;';
  var SHOW = {
    hidden: 'display:none;width:0;height:0;',
    bubble: 'display:block;width:92px;height:92px;',
    // The second pair wins where the browser understands it; an old browser keeps the first.
    open: 'display:block;width:404px;height:660px;width:min(404px,100vw);height:min(660px,100vh);',
  };

  function start() {
    var frame = document.createElement('iframe');
    frame.title = 'Chat';
    frame.setAttribute('allow', '');
    // The frame may run its own script and keep its own storage. It may not navigate this page or submit forms.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.style.cssText = PLACE + SHOW.hidden;
    frame.src = origin + '/chat/frame?site=' + encodeURIComponent(site) + '&page=' + encodeURIComponent(String(location.pathname || '/').slice(0, 200));

    window.addEventListener('message', function (event) {
      // Only the chat frame itself, on Timmy's address, is listened to.
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      var data = event.data;
      if (!data || data.timmyChat !== 1 || typeof data.show !== 'string' || !Object.prototype.hasOwnProperty.call(SHOW, data.show)) return;
      frame.style.cssText = PLACE + SHOW[data.show];
    });
    document.body.appendChild(frame);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
