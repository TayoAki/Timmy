/*
 * Timmy website chat: the chat itself, running inside the frame the loader adds to a business's website.
 *
 * It shows the bubble and the chat window, sends what the visitor types to Timmy's server, and shows what
 * comes back. It decides nothing: every answer is worked out on the server.
 *
 * Everything that arrives from the network or from the visitor is put on the page as text (textContent),
 * never as markup, so nothing anyone types can become part of the page. The page that holds the frame is
 * told only how to show it (hidden, bubble or open), and is never listened to.
 * Plain JavaScript, no dependencies.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var site = params.get('site') || '';
  var page = params.get('page') || '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(site)) return;
  var api = '/api/public/chat/' + site;
  var MAX_CHARS = 2000;
  var NOT_SENT = 'That didn’t send. Check your connection and try again.';

  /* ── Talking to the page that holds the frame ── */

  function show(how) {
    try {
      // Nothing private is in this message, and the frame can't know which of the site's addresses holds it.
      window.parent.postMessage({ timmyChat: 1, show: how }, '*');
    } catch (e) {
      /* not in a frame */
    }
  }

  /* ── What this browser remembers: an anonymous visitor id and the conversation's token ── */

  var memory = {};
  var prefix = 'timmy-chat:' + site + ':';
  function recall(key) {
    try {
      var v = window.localStorage.getItem(prefix + key);
      if (v !== null) return v;
    } catch (e) {
      /* storage is blocked: remember for this page view only */
    }
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }
  function remember(key, value) {
    if (value === null) delete memory[key];
    else memory[key] = value;
    try {
      if (value === null) window.localStorage.removeItem(prefix + key);
      else window.localStorage.setItem(prefix + key, value);
    } catch (e) {
      /* storage is blocked */
    }
  }
  function randomId() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    return out;
  }

  var visitor = recall('visitor');
  if (!visitor || !/^[A-Za-z0-9_-]{16,64}$/.test(visitor)) {
    visitor = randomId();
    remember('visitor', visitor);
  }
  var conversation = recall('conversation');
  var token = recall('token');

  /* ── State ── */

  var settings = null;
  var isOpen = false;
  var tab = 'chat';
  /** Messages the server has confirmed, in the conversation's order. */
  var messages = [];
  /** The visitor's own messages that are on their way. */
  var sending = [];
  /** Replies that arrived while the "typing" dots were still showing. */
  var held = [];
  var last = 0;
  var typing = false;
  var busy = false;
  var notice = '';
  var unseen = false;
  var historyLoaded = false;

  /* ── Building the page: elements and text only ── */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function icon(paths) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    return svg;
  }
  var ICON_CHAT = ['M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.7 8.7 0 0 1-3.8-.9L3 20l1.2-5.1a8.1 8.1 0 0 1-.7-3.4A8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3z'];
  var ICON_CLOSE = ['M18 6 6 18', 'M6 6l12 12'];
  var ICON_SEND = ['M12 19V5', 'M5 12l7-7 7 7'];

  /** A picture is only ever one of the small image kinds the Set up screen accepts, carried inline. */
  function picture() {
    var src = settings && settings.icon;
    if (typeof src !== 'string' || !/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return null;
    var img = el('img');
    img.alt = '';
    img.src = src;
    return img;
  }
  function face(small) {
    var f = el('span', 'tc-face' + (small ? ' small' : ''));
    f.appendChild(picture() || icon(ICON_CHAT));
    return f;
  }

  var root = document.getElementById('chat');
  var launcher, dot, win, body, input, sendButton, noticeLine, tabChat, tabHelp, composer;

  function build() {
    var color = /^#[0-9a-fA-F]{6}$/.test(settings.color || '') ? settings.color : '#3f51d9';
    document.documentElement.style.setProperty('--wc', color);

    win = el('section', 'tc-window');
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', (settings.name || 'Chat') + ' chat');
    win.hidden = true;

    var head = el('header', 'tc-head');
    head.appendChild(face(false));
    var title = el('span', 'tc-title');
    title.appendChild(el('strong', '', settings.name || 'Chat'));
    var sub = el('span');
    sub.appendChild(el('i', 'tc-online'));
    sub.appendChild(document.createTextNode('Timmy replies right away'));
    title.appendChild(sub);
    head.appendChild(title);
    var close = el('button', 'tc-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the chat');
    close.appendChild(icon(ICON_CLOSE));
    close.addEventListener('click', function () {
      setOpen(false);
    });
    head.appendChild(close);
    win.appendChild(head);

    var tabs = el('div', 'tc-tabs');
    tabs.setAttribute('role', 'tablist');
    tabChat = el('button', '', 'Chat');
    tabHelp = el('button', '', 'Help desk');
    [tabChat, tabHelp].forEach(function (b, i) {
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', function () {
        tab = i === 0 ? 'chat' : 'help';
        render();
      });
      tabs.appendChild(b);
    });
    if (settings.faq && settings.faq.length) win.appendChild(tabs);

    body = el('div', 'tc-body');
    body.setAttribute('aria-live', 'polite');
    win.appendChild(body);

    noticeLine = el('p', 'tc-notice');
    noticeLine.setAttribute('role', 'status');
    noticeLine.hidden = true;
    win.appendChild(noticeLine);

    // Not a <form>: the frame is not allowed to submit forms, and has nowhere to submit one to.
    composer = el('div', 'tc-compose');
    input = el('input');
    input.type = 'text';
    input.maxLength = MAX_CHARS;
    input.placeholder = 'Type your message';
    input.setAttribute('aria-label', 'Message');
    input.autocomplete = 'off';
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', function () {
      sendButton.disabled = busy || !input.value.trim();
    });
    sendButton = el('button', 'tc-send');
    sendButton.type = 'button';
    sendButton.disabled = true;
    sendButton.setAttribute('aria-label', 'Send');
    sendButton.appendChild(icon(ICON_SEND));
    sendButton.addEventListener('click', send);
    composer.appendChild(input);
    composer.appendChild(sendButton);
    win.appendChild(composer);
    win.appendChild(el('footer', 'tc-foot', 'Powered by Timmy'));

    launcher = el('button', 'tc-launcher');
    launcher.type = 'button';
    launcher.addEventListener('click', function () {
      setOpen(!isOpen);
    });
    dot = el('span', 'tc-dot');
    dot.hidden = true;

    root.appendChild(win);
    root.appendChild(launcher);
    root.appendChild(dot);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) setOpen(false);
    });
  }

  function bubble(from, text, extra) {
    var row = el('div', 'tc-row' + (from === 'visitor' ? ' visitor' : '') + (extra && extra.unsent ? ' unsent' : ''));
    if (from !== 'visitor') row.appendChild(face(true));
    var b = el('div', 'tc-bubble');
    if (from !== 'visitor') b.appendChild(el('span', 'tc-who', from === 'person' ? settings.name || 'Team' : 'Timmy'));
    b.appendChild(el('p', '', text));
    if (extra && extra.privacy && typeof settings.privacyUrl === 'string' && /^https:\/\/[^\s"'<>\\]+$/.test(settings.privacyUrl)) {
      var note = el('p', 'tc-privacy', 'Your email is only used to reply to you. ');
      var link = el('a', '', 'Privacy policy');
      link.href = settings.privacyUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      note.appendChild(link);
      b.appendChild(note);
    }
    row.appendChild(b);
    return row;
  }

  function render() {
    if (!settings) return;
    win.hidden = !isOpen;
    launcher.setAttribute('aria-label', isOpen ? 'Hide the chat' : 'Open the chat');
    launcher.textContent = '';
    launcher.appendChild(isOpen ? icon(ICON_CLOSE) : picture() || icon(ICON_CHAT));
    dot.hidden = isOpen || !unseen;
    tabChat.setAttribute('aria-selected', String(tab === 'chat'));
    tabHelp.setAttribute('aria-selected', String(tab === 'help'));
    composer.hidden = tab !== 'chat';
    noticeLine.hidden = tab !== 'chat' || !notice;
    noticeLine.textContent = notice;
    sendButton.disabled = busy || !input.value.trim();

    body.textContent = '';
    if (tab === 'help') {
      body.appendChild(el('p', 'tc-help-intro', 'Questions people usually ask.'));
      (settings.faq || []).forEach(function (f) {
        var item = el('details', 'tc-faq');
        item.appendChild(el('summary', '', f.q));
        item.appendChild(el('p', '', f.a));
        body.appendChild(item);
      });
      return;
    }
    if (settings.greeting) body.appendChild(bubble('timmy', settings.greeting));
    messages.forEach(function (m) {
      body.appendChild(bubble(m.from, m.text, { privacy: m.notice === 'privacy' }));
    });
    sending.forEach(function (m) {
      body.appendChild(bubble('visitor', m.text, { unsent: true }));
    });
    if (typing) {
      var row = el('div', 'tc-row');
      row.appendChild(face(true));
      var dots = el('div', 'tc-bubble tc-typing');
      dots.setAttribute('aria-label', 'Timmy is typing');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      row.appendChild(dots);
      body.appendChild(row);
    }
    body.scrollTop = body.scrollHeight;
  }

  function setOpen(open) {
    isOpen = open;
    if (open) unseen = false;
    show(open ? 'open' : 'bubble');
    render();
    if (open && tab === 'chat') input.focus();
  }

  /* ── Messages from the server ── */

  function accept(m) {
    if (!m || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.seq !== 'number') return;
    if (m.seq > last) last = m.seq;
    for (var i = 0; i < messages.length; i++) if (messages[i].id === m.id) return;
    if (m.from === 'visitor' && m.client) {
      sending = sending.filter(function (s) {
        return s.client !== m.client;
      });
    }
    messages.push({ id: m.id, seq: m.seq, from: m.from === 'visitor' ? 'visitor' : m.from === 'person' ? 'person' : 'timmy', text: m.text, notice: m.notice });
    messages.sort(function (a, b) {
      return a.seq - b.seq;
    });
    if (m.from !== 'visitor' && !isOpen && historyLoaded) unseen = true;
  }
  function receive(m) {
    // While the dots show, a reply waits for them to finish, so it doesn't appear before "typing" does.
    if (typing && m && m.from !== 'visitor') held.push(m);
    else accept(m);
    render();
  }
  function releaseHeld() {
    var list = held;
    held = [];
    list.forEach(accept);
  }

  function forget() {
    conversation = null;
    token = null;
    remember('conversation', null);
    remember('token', null);
    if (stream) stream.abort();
  }

  /* ── The stream: replies as they happen, and the history when the visitor comes back ── */

  var stream = null;
  var retryIn = 1000;

  function connect() {
    // No stream while the page is in the background: it is opened again, from where it stopped, when the visitor returns.
    if (stream || !conversation || !token || document.hidden) return;
    var control = new AbortController();
    stream = control;
    var wait = retryIn;
    fetch(api + '/stream?conversation=' + encodeURIComponent(conversation) + '&after=' + last, {
      headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' },
      credentials: 'omit',
      cache: 'no-store',
      signal: control.signal,
    })
      .then(function (res) {
        if (res.status === 403) {
          // The conversation is over (deleted, or the token ran out). The next message starts a new one.
          forget();
          return;
        }
        if (res.status === 404 || res.status === 429) wait = 30000;
        if (!res.ok || !res.body) return;
        retryIn = 1000;
        wait = 1000;
        return read(res.body.getReader());
      })
      .catch(function () {
        wait = Math.min(wait * 2, 30000);
      })
      .then(function () {
        if (stream === control) stream = null;
        historyLoaded = true;
        retryIn = wait;
        if (conversation && token && !document.hidden) window.setTimeout(connect, wait);
      });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (stream) stream.abort();
    } else {
      connect();
    }
  });

  function read(reader) {
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        var at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          handle(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
        }
        return pump();
      });
    }
    return pump();
  }
  function handle(block) {
    var event = 'message';
    var data = '';
    block.split('\n').forEach(function (line) {
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
    });
    if (event === 'ready') {
      historyLoaded = true;
      return;
    }
    if (event !== 'message' || !data) return;
    try {
      receive(JSON.parse(data));
    } catch (e) {
      /* not a message */
    }
  }

  /* ── Sending ── */

  function post(payload) {
    var once = function () {
      return fetch(api + '/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', body: JSON.stringify(payload) });
    };
    // A request lost on the way is sent once more as it was. It carries the same id, so the server keeps one copy.
    return once()
      .catch(once)
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: false, notice: NOT_SENT };
        });
      });
  }

  function send() {
    var text = input.value.trim();
    if (!text || busy) return;
    if (text.length > MAX_CHARS) {
      notice = 'That message is too long. Keep it under 2,000 characters.';
      render();
      return;
    }
    var mine = { client: randomId(), text: text };
    var started = Date.now();
    input.value = '';
    notice = '';
    busy = true;
    typing = true;
    sending.push(mine);
    render();

    var payload = { visitor: visitor, id: mine.client, text: text, after: last };
    if (page) payload.page = page;
    if (conversation && token) {
      payload.conversation = conversation;
      payload.token = token;
    }
    var finish = function (out) {
      busy = false;
      typing = false;
      if (out && out.ok === true && typeof out.conversation === 'string' && typeof out.token === 'string') {
        conversation = out.conversation;
        token = out.token;
        remember('conversation', conversation);
        remember('token', token);
        (out.messages || []).forEach(accept);
        historyLoaded = true;
        releaseHeld();
        connect();
      } else {
        // Refused, with a plain sentence. The words go back into the box so nothing the visitor wrote is lost.
        sending = sending.filter(function (s) {
          return s !== mine;
        });
        releaseHeld();
        notice = (out && typeof out.notice === 'string' && out.notice) || NOT_SENT;
        if (out && out.reset) forget();
        if (!input.value) input.value = text;
      }
      render();
      if (isOpen) input.focus();
    };
    post(payload)
      .catch(function () {
        return { ok: false, notice: NOT_SENT };
      })
      .then(function (out) {
        // A short pause, so an instant answer still reads as someone replying.
        window.setTimeout(function () {
          finish(out);
        }, Math.max(0, 450 - (Date.now() - started)));
      });
  }

  /* ── Start ── */

  show('hidden');
  fetch(api + '/config', { headers: { accept: 'application/json' }, credentials: 'omit' })
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (data) {
      // No settings means the chat is off for this website: the frame stays hidden and nothing more is asked.
      if (!data || typeof data !== 'object' || typeof data.name !== 'string') return;
      settings = data;
      build();
      render();
      show('bubble');
      if (conversation && token) connect();
      else historyLoaded = true;
    })
    .catch(function () {
      /* the frame stays hidden */
    });
})();
