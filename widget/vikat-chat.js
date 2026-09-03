/**
 * vikat-chat.js — Vikat internal sales assistant widget.
 *
 * Vanilla JS, no dependencies, no build step.
 *
 * Embed contract (unchanged from the original spec, so the endpoint can move
 * without touching the widget):
 *
 *   <link rel="stylesheet" href="/assets/vikat-chat.css">
 *   <script src="/assets/vikat-chat.js"
 *           data-endpoint="https://sales-assistant.vikat.ai"
 *           data-mode="inline"           <!-- optional: inline | float -->
 *           data-mount="#assistant"      <!-- required when mode=inline -->
 *           defer></script>
 *
 * AUDIENCE: authenticated Vikat employees. The backend refuses anonymous
 * requests, so a 401 here means "your SSO session lapsed", not "sign up".
 */

(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  // --- Config (rule 5: the endpoint is a data attribute, never a literal) ---
  // data-endpoint="/" means same-origin, which is how this is deployed: the
  // Worker serves these files as well as the API. An absolute URL still works
  // for a separately hosted front end.
  var RAW_ENDPOINT = script.getAttribute('data-endpoint');
  var ENDPOINT = (RAW_ENDPOINT || '').replace(/\/+$/, '');
  var MODE = script.getAttribute('data-mode') === 'inline' ? 'inline' : 'float';
  var MOUNT = script.getAttribute('data-mount');

  if (RAW_ENDPOINT === null) {
    console.error('[vikat-chat] data-endpoint is required. Use "/" for same-origin.');
    return;
  }

  var STORAGE_KEY = 'vikat-assistant-history';
  var SESSION_KEY = 'vikat-assistant-session';
  var MAX_TURNS = 100;

  var SUGGESTIONS = [
    'Brief me on VCommand',
    'What does VShield do about MCP servers?',
    'Customer asked how we deploy — what can I say?',
    'Can I share pricing with a prospect?',
  ];

  // --- State ---------------------------------------------------------------

  /** @type {{role: string, content: string}[]} */
  var history = [];

  // Listeners for the surrounding app. The widget owns the conversation, so
  // the rails around it have to be told when it changes rather than polling
  // for it — and a rail that guessed by reading sessionStorage would miss the
  // moment a stream produced an asset.
  var listeners = {};

  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }

  function emit(name, payload) {
    (listeners[name] || []).forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[chat] listener for ' + name + ' failed:', err);
      }
    });
  }
  var busy = false;
  var controller = null;

  // --- Utilities -----------------------------------------------------------

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function sessionId() {
    var id = null;
    try {
      id = sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
      // Private mode or blocked storage: fall through to an in-memory id.
    }
    if (id) return id;

    id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    try {
      sessionStorage.setItem(SESSION_KEY, id);
    } catch (e) {
      /* not persistable; the id still works for this page view */
    }
    return id;
  }

  function loadHistory() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_TURNS)));
    } catch (e) {
      /* quota or blocked storage; the conversation still works in memory */
    }
  }

  // --- Disclosure tags -----------------------------------------------------

  // The system prompt ends an answer with e.g. "[Internal only] — do not repeat…".
  // Pulling those onto their own chip is the whole point of the tool: a rep
  // must not be able to skim past the line that says "don't repeat this".
  var TAG_PATTERNS = [
    { re: /^\[OK to share\]/i, cls: 'vk-tag-ok', label: 'OK to share' },
    { re: /^\[Internal only\]/i, cls: 'vk-tag-internal', label: 'Internal only' },
    { re: /^\[Check before sharing\]/i, cls: 'vk-tag-approval', label: 'Check before sharing' },
  ];

  /**
   * Split trailing disclosure lines off the body of a reply.
   * @returns {{ body: string, tags: {cls: string, label: string, note: string}[] }}
   */
  function splitTags(text) {
    var lines = text.split('\n');
    var tags = [];

    while (lines.length > 0) {
      var last = lines[lines.length - 1].trim();
      if (!last) {
        lines.pop();
        continue;
      }
      var matched = null;
      for (var i = 0; i < TAG_PATTERNS.length; i++) {
        if (TAG_PATTERNS[i].re.test(last)) {
          matched = TAG_PATTERNS[i];
          break;
        }
      }
      if (!matched) break;

      // Keep any explanation the model appended after the tag itself.
      var note = last.replace(/^\[[^\]]+\]\s*[—-]?\s*/, '').trim();
      tags.unshift({ cls: matched.cls, label: matched.label, note: note });
      lines.pop();
    }

    return { body: lines.join('\n').trim(), tags: tags };
  }

  // --- DOM -----------------------------------------------------------------

  var root = el('div', 'vk-root');
  root.setAttribute('data-mode', MODE);

  var launcher = el('button', 'vk-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Open the Vikat sales assistant');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg>';

  var panel = el('div', 'vk-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Vikat sales assistant');
  panel.setAttribute('aria-modal', 'false');

  // Header
  var header = el('div', 'vk-header');
  var mark = el('div', 'vk-mark', 'V');
  mark.setAttribute('aria-hidden', 'true');

  var titles = el('div', 'vk-titles');
  titles.appendChild(el('div', 'vk-title', 'Sales Assistant'));
  var sub = el('div', 'vk-sub', 'Internal · conversations are logged');
  titles.appendChild(sub);

  var resetBtn = el('button', 'vk-iconbtn');
  resetBtn.type = 'button';
  resetBtn.title = 'Start a new conversation';
  resetBtn.setAttribute('aria-label', 'Start a new conversation');
  resetBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

  var closeBtn = el('button', 'vk-iconbtn');
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close the assistant');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  header.appendChild(mark);
  header.appendChild(titles);
  header.appendChild(resetBtn);
  if (MODE === 'float') header.appendChild(closeBtn);

  // Log
  var log = el('div', 'vk-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions text');

  // Composer
  var composer = el('form', 'vk-composer');
  var input = el('textarea', 'vk-input');
  input.rows = 1;
  input.placeholder = 'Ask about products, pricing, competitors…';
  input.setAttribute('aria-label', 'Message the sales assistant');
  // No maxlength. A rep pastes a whole RFP or a chain of six emails, and a
  // textarea that silently truncates at 8000 characters is worse than one that
  // refuses: the paste LOOKS complete and the answer is confidently based on
  // half of it. The server has the only limit, and it is large enough that
  // nothing a person pastes reaches it.

  var send = el('button', 'vk-send');
  send.type = 'submit';
  send.disabled = true;
  send.setAttribute('aria-label', 'Send message');
  send.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 14-7-7 14-2-5-5-2z"/></svg>';

  composer.appendChild(input);
  composer.appendChild(send);

  var foot = el('div', 'vk-foot', 'AI assistant · verify anything before you send it to a customer');

  panel.appendChild(header);
  panel.appendChild(log);
  panel.appendChild(composer);
  panel.appendChild(foot);

  if (MODE === 'float') {
    panel.classList.add('vk-hidden');
    root.appendChild(launcher);
  }
  root.appendChild(panel);

  // --- Rendering -----------------------------------------------------------

  function renderEmpty() {
    var wrap = el('div', 'vk-empty');
    var h = el('h3', null, 'What do you need?');
    wrap.appendChild(h);
    wrap.appendChild(
      el(
        'p',
        null,
        'I answer from Vikat’s own material — product pages, decks and internal docs — and tell you what’s safe to repeat to a customer.',
      ),
    );

    var chips = el('div', 'vk-suggestions');
    SUGGESTIONS.forEach(function (s) {
      var b = el('button', 'vk-chip', s);
      b.type = 'button';
      b.addEventListener('click', function () {
        input.value = s;
        autosize();
        submit();
      });
      chips.appendChild(b);
    });
    wrap.appendChild(chips);
    log.appendChild(wrap);
  }

  function addUser(text) {
    var n = el('div', 'vk-msg vk-msg-user', text);
    log.appendChild(n);
    scroll();
    return n;
  }

  // Markdown links and bare URLs.
  //
  // Three alternatives, in order: a markdown link to an absolute http(s) URL
  // (a SharePoint document); a markdown link to a same-origin path (a document
  // this Worker generated, at /document/<id>); and a bare http(s) URL in prose.
  //
  // The same-origin branch requires exactly one leading slash: "//evil.test"
  // is protocol-relative and would leave the origin. No scheme can appear in
  // any branch, so javascript: and data: never match and there is nothing to
  // sanitise afterwards.
  var LINK_RE = /\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)|\[([^\]\n]{1,120})\]\((\/[^\/\s)][^\s)]*)\)|(https?:\/\/[^\s<>"')\]]+)/g;

  /**
   * Emit plain text, promoting **bold** as it goes.
   *
   * The innermost layer, and the only one that creates text nodes.
   */
  function emitText(parent, text) {
    var parts = text.split(/\*\*([^*\n]+)\*\*/);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) parent.appendChild(el('strong', null, parts[i]));
      else parent.appendChild(document.createTextNode(parts[i]));
    }
  }

  /** Emit text with links turned into anchors, and bold inside the rest. */
  function emitLinked(parent, text) {
    LINK_RE.lastIndex = 0;

    var last = 0;
    var m;

    while ((m = LINK_RE.exec(text)) !== null) {
      if (m.index > last) emitText(parent, text.slice(last, m.index));

      var label = m[1] || m[3];
      var url = m[2] || m[4] || m[5];
      var sameOrigin = Boolean(m[4]);
      var trail = '';

      if (!label) {
        // Bare URL: trailing punctuation belongs to the sentence, not the link.
        while (/[.,;:!?]$/.test(url)) {
          trail = url.slice(-1) + trail;
          url = url.slice(0, -1);
        }
      }

      var a = el('a', 'vk-link', label || url);
      a.href = url;
      // A generated document is served as an attachment from this same origin,
      // so it downloads in place rather than opening a blank tab first.
      if (!sameOrigin) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      parent.appendChild(a);

      if (trail) parent.appendChild(document.createTextNode(trail));
      last = m.index + m[0].length;
    }

    if (last < text.length) emitText(parent, text.slice(last));
  }

  /**
   * Inline markup: code spans, then links, then bold.
   *
   * Code first because its content is literal — an asterisk or a bracket
   * inside backticks is a character, not markup.
   */
  function renderInline(parent, text) {
    var parts = text.split(/`([^`\n]+)`/);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) parent.appendChild(el('code', 'vk-code', parts[i]));
      else emitLinked(parent, parts[i]);
    }
  }

  var BULLET = /^\s*[-*]\s+(.*)$/;
  var NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
  var HEADING = /^\s*(#{1,3})\s+(.*)$/;

  /**
   * Render agent text into `node` as blocks: headings, lists and paragraphs.
   *
   * The prompt asks the model for "short lists, clear headers" on a brief, and
   * it obliges. Until this existed, all of that arrived as literal "- " and
   * "**" in one undifferentiated wall of text — the structure was being
   * produced and then thrown away, which is worse than never asking for it.
   *
   * Built from text nodes and elements, never innerHTML: the model's output is
   * untrusted in the ordinary way — it summarises documents anyone at Vikat can
   * put in SharePoint — and one document with markup in its title should not
   * become script in a rep's browser. Every branch below appends nodes; none
   * assigns markup. That is the property the tests check, not the prettiness.
   */
  function renderBody(node, text) {
    node.textContent = '';

    var lines = String(text == null ? '' : text).split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      var h = HEADING.exec(line);
      if (h) {
        var head = el('div', 'vk-h vk-h' + h[1].length);
        renderInline(head, h[2]);
        node.appendChild(head);
        i += 1;
        continue;
      }

      var isBullet = BULLET.test(line);
      if (isBullet || NUMBERED.test(line)) {
        var list = el(isBullet ? 'ul' : 'ol', 'vk-list');
        var re = isBullet ? BULLET : NUMBERED;

        while (i < lines.length) {
          var item = re.exec(lines[i]);
          if (!item) break;
          var li = el('li');
          renderInline(li, item[1]);
          list.appendChild(li);
          i += 1;
        }

        node.appendChild(list);
        continue;
      }

      // A paragraph runs until a blank line or the start of another block.
      // Single newlines inside it are kept as breaks: the model uses them to
      // separate a claim from its caveat, and joining them loses that.
      var para = el('p', 'vk-p');
      var first = true;

      while (i < lines.length) {
        var l = lines[i];
        if (!l.trim() || HEADING.test(l) || BULLET.test(l) || NUMBERED.test(l)) break;
        if (!first) para.appendChild(el('br'));
        renderInline(para, l);
        first = false;
        i += 1;
      }

      node.appendChild(para);
    }
  }

  /** Agent bubble with an update() that re-splits disclosure tags as it streams. */
  function addAgent() {
    var wrap = el('div', 'vk-msg vk-msg-agent');
    var body = el('div');
    var tagRow = el('div');
    wrap.appendChild(body);
    wrap.appendChild(tagRow);
    log.appendChild(wrap);
    scroll();

    return {
      node: wrap,
      update: function (full) {
        var split = splitTags(full);
        renderBody(body, split.body);

        // Cheap to rebuild: there are at most a couple of tags.
        tagRow.textContent = '';
        split.tags.forEach(function (t) {
          var chip = el('span', 'vk-tag ' + t.cls, t.label);
          if (t.note) chip.title = t.note;
          tagRow.appendChild(chip);
          tagRow.appendChild(document.createTextNode(' '));
        });
        scroll();
      },
    };
  }

  function addStatus(text) {
    var n = el('div', 'vk-status');
    n.appendChild(el('span', 'vk-dot'));
    n.appendChild(el('span', null, text));
    log.appendChild(n);
    scroll();
    return n;
  }

  /**
   * A draft, as something to copy rather than something to read.
   *
   * The whole point of the card. An email written into the answer text is
   * still an email, and it is also four paragraphs a rep has to select around
   * markdown, a subject line they have to find inside a sentence, and a "here
   * is a draft" they have to delete. Two buttons remove all of that.
   */
  function addDraft(draft) {
    var card = el('div', 'vk-draft');

    var head = el('div', 'vk-draft-head');
    head.appendChild(el('span', 'vk-draft-ch', draft.channelLabel || 'Draft'));
    if (draft.label && draft.label !== draft.channelLabel) {
      head.appendChild(el('span', 'vk-draft-label', draft.label));
    }
    card.appendChild(head);

    if (draft.subject) {
      var subjRow = el('div', 'vk-draft-row');
      subjRow.appendChild(el('div', 'vk-draft-k', 'Subject'));
      subjRow.appendChild(el('div', 'vk-draft-v', draft.subject));
      subjRow.appendChild(copyButton('Copy', draft.subject));
      card.appendChild(subjRow);
    }

    var bodyRow = el('div', 'vk-draft-row vk-draft-body');
    bodyRow.appendChild(el('div', 'vk-draft-k', draft.subject ? 'Body' : 'Message'));
    // textContent, never innerHTML: this is plain text headed for an email
    // client, and the prospect's own name is in it.
    bodyRow.appendChild(el('div', 'vk-draft-v vk-draft-text', draft.body));
    bodyRow.appendChild(copyButton('Copy', draft.body));
    card.appendChild(bodyRow);

    var foot = el('div', 'vk-draft-foot');
    if (draft.subject) {
      foot.appendChild(copyButton('Copy subject + body', draft.subject + '\n\n' + draft.body, true));
    }
    // A character count, because LinkedIn silently refuses a connection note
    // over 300 and an email over ~200 words gets skimmed. The rep is the one
    // who decides; they just need to be able to see it.
    foot.appendChild(el('span', 'vk-draft-count', draft.body.length + ' characters'));
    card.appendChild(foot);

    log.appendChild(card);
    scroll();
    return card;
  }

  function copyButton(label, text, primary) {
    var b = el('button', 'vk-copy' + (primary ? ' vk-copy-main' : ''), label);
    b.type = 'button';

    b.addEventListener('click', function () {
      copyText(text).then(
        function () {
          var was = b.textContent;
          b.textContent = 'Copied';
          b.classList.add('done');
          setTimeout(function () {
            b.textContent = was;
            b.classList.remove('done');
          }, 1600);
        },
        function () {
          // Clipboard access can be refused outright. Saying so beats a button
          // that looks like it worked and put nothing on the clipboard.
          b.textContent = 'Press Ctrl+C';
          selectText(b.closest('.vk-draft-row').querySelector('.vk-draft-v'));
        },
      );
    });

    return b;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Older browsers, and any context where the async clipboard is blocked.
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('refused'));
      } catch (e) {
        reject(e);
      } finally {
        ta.remove();
      }
    });
  }

  /** Last resort: put the text under the cursor so Ctrl+C works. */
  function selectText(node) {
    if (!node) return;
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function addError(message, opts) {
    var n = el('div', 'vk-error');
    n.appendChild(document.createTextNode(message));

    if (opts && opts.reload) {
      n.appendChild(document.createTextNode(' '));
      var a = el('a', null, 'Reload to sign in.');
      a.href = '#';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        location.reload();
      });
      n.appendChild(a);
    }

    if (opts && opts.detail) {
      var d = el('details', 'vk-detail');
      d.appendChild(el('summary', null, 'What the API said'));
      d.appendChild(el('div', 'vk-detail-body', opts.detail));
      n.appendChild(d);
    }

    if (opts && opts.retry) {
      n.appendChild(document.createTextNode(' '));
      var r = el('a', null, 'Retry.');
      r.href = '#';
      r.addEventListener('click', function (e) {
        e.preventDefault();
        n.remove();
        // The failed turn is still the last user message; replay it.
        var last = history[history.length - 1];
        if (last && last.role === 'user') {
          history.pop();
          input.value = last.content;
          autosize();
          submit();
        }
      });
      n.appendChild(r);
    }

    log.appendChild(n);
    scroll();
    return n;
  }

  var pinned = true;

  function scroll() {
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  log.addEventListener('scroll', function () {
    // Stop yanking the view down if the rep has scrolled up to read.
    pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  });

  function repaint() {
    log.textContent = '';
    if (history.length === 0) {
      renderEmpty();
      return;
    }
    history.forEach(function (m) {
      if (m.role === 'user') {
        addUser(m.content);
      } else {
        addAgent().update(m.content);
      }
    });
  }

  // --- Networking ----------------------------------------------------------

  /**
   * Parse an SSE byte stream into {event, data} frames.
   * Written by hand rather than using EventSource, because EventSource cannot
   * issue a POST and cannot send credentials the way this endpoint needs.
   */
  function parseFrames(buffer, onFrame) {
    var parts = buffer.split('\n\n');
    var remainder = parts.pop();

    parts.forEach(function (raw) {
      var event = 'message';
      var data = '';
      raw.split('\n').forEach(function (line) {
        if (line.indexOf('event:') === 0) event = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
      });
      if (!data) return;
      try {
        onFrame(event, JSON.parse(data));
      } catch (e) {
        /* a partial or malformed frame is not worth breaking the stream over */
      }
    });

    return remainder;
  }

  async function submit() {
    var text = input.value.trim();
    if (!text || busy) return;

    var empty = log.querySelector('.vk-empty');
    if (empty) empty.remove();

    input.value = '';
    autosize();
    setBusy(true);

    history.push({ role: 'user', content: text });
    addUser(text);
    saveHistory();

    var status = addStatus('Thinking');
    var bubble = null;
    // `answer` is what the CURRENT bubble shows; `spoken` is everything the
    // assistant said this turn. They diverge the moment a draft card splits
    // the reply into two bubbles, and conflating them is how the text before
    // the card would vanish from the history that gets resent next turn.
    var answer = '';
    var spoken = '';

    controller = new AbortController();

    try {
      var res = await fetch(ENDPOINT + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Carries the Cloudflare Access cookie on a cross-origin request.
        credentials: 'include',
        body: JSON.stringify({ sessionId: sessionId(), messages: history }),
        signal: controller.signal,
      });

      if (!res.ok) {
        status.remove();
        var payload = {};
        try {
          payload = await res.json();
        } catch (e) {
          /* non-JSON error body */
        }

        if (res.status === 401) {
          addError(
            payload.error || 'Your session has expired.',
            // Only offered where a fresh sign-in is actually the fix. The
            // server says so; see authFailure() in the Worker.
            payload.retry === 'never' ? {} : { reload: true },
          );
        } else if (res.status === 403) {
          // The wrong account, or one without access. Neither a reload nor a
          // retry changes anything, and offering one sends the rep round a
          // loop instead of to whoever can grant them access.
          addError(payload.error || 'Your account does not have access to the sales assistant.');
        } else if (res.status === 429) {
          addError(payload.error || 'Rate limit reached. Try again shortly.');
        } else {
          addError(payload.error || 'Something went wrong (' + res.status + ').', { retry: true });
        }
        history.pop();
        saveHistory();
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = parseFrames(buffer, function (event, data) {
          if (event === 'text') {
            if (!bubble) {
              status.remove();
              bubble = addAgent();
            }
            answer += data.text;
            spoken += data.text;
            bubble.update(answer);
          } else if (event === 'tool') {
            status.textContent = '';
            status.appendChild(el('span', 'vk-dot'));
            status.appendChild(el('span', null, toolLabel(data.name)));
          } else if (event === 'asset') {
            emit('asset', data.assets || []);
          } else if (event === 'reset') {
            // The server abandoned a half-streamed answer and is starting the
            // turn again. Without this the rep reads the discarded half and
            // the real answer as one paragraph.
            if (bubble && bubble.node) bubble.node.remove();
            bubble = null;
            answer = '';
            spoken = '';
            if (!status.isConnected) log.appendChild(status);
          } else if (event === 'draft') {
            status.remove();
            (data.drafts || []).forEach(addDraft);
            // The answer continues after the card, so a fresh bubble is needed
            // — otherwise the model's explanation appends to the bubble that
            // was open before the draft and reads as part of it.
            bubble = null;
            answer = '';
          } else if (event === 'error') {
            status.remove();
            // `detail` is the upstream reason, sent only to admins. The server
            // already went to the trouble of including it and this dropped it
            // on the floor — which is how "Something went wrong" reached an
            // admin who was one line away from knowing exactly what broke.
            addError(data.message, { retry: data.code === 'upstream_busy', detail: data.detail });
          }
        });
      }

      status.remove();

      if (spoken.trim()) {
        history.push({ role: 'assistant', content: spoken });
        saveHistory();
        // The server indexed this conversation on the turn it just handled, so
        // a brand-new chat only becomes listable now. The rail refreshes on
        // this rather than on send, or it would ask before the entry existed.
        emit('turn', sessionId());
      } else {
        // Nothing came back — do not leave a stale user turn that would be
        // resent with the next message.
        history.pop();
        saveHistory();
      }
    } catch (err) {
      status.remove();
      if (err && err.name === 'AbortError') {
        history.pop();
        saveHistory();
        return;
      }
      addError('Could not reach the assistant. Check your connection.', { retry: true });
      history.pop();
      saveHistory();
    } finally {
      setBusy(false);
      controller = null;
      input.focus();
    }
  }

  function toolLabel(name) {
    if (name === 'log_prospect') return 'Logging the prospect';
    if (name === 'ask_expert') return 'Routing to an expert';
    if (name === 'flag_content_gap') return 'Flagging a content gap';
    if (name === 'find_collateral') return 'Searching our material';
    if (name === 'create_document') return 'Building the document';
    // Named apart from the internal search on purpose: a rep should be able
    // to tell at a glance whether an answer came from our material or from
    // the open web.
    if (name === 'web_search') return 'Searching the web';
    if (name === 'web_fetch') return 'Reading a page';
    return 'Working';
  }

  function setBusy(v) {
    busy = v;
    send.disabled = v || input.value.trim() === '';
    input.disabled = v;
  }

  // --- Events --------------------------------------------------------------

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    send.disabled = busy || input.value.trim() === '';
  }

  input.addEventListener('input', autosize);

  input.addEventListener('keydown', function (e) {
    // Enter sends; Shift+Enter is a newline. Standard for a chat composer.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    submit();
  });

  /** Abandon this conversation and start an unnamed one. */
  function newChat() {
    if (controller) controller.abort();
    history = [];
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
      /* nothing to clear */
    }
    repaint();
    emit('session', sessionId());
    input.focus();
  }

  /**
   * Reopen a past conversation.
   *
   * `turns` comes from GET /chats/:id, which is the SERVER's record of what
   * was said. Replaying from there rather than from sessionStorage is what
   * makes a chat openable on a second machine at all.
   */
  function openChat(id, turns, drafts) {
    if (controller) controller.abort();

    history = [];
    (turns || []).forEach(function (turn) {
      if (turn.userMessage) history.push({ role: 'user', content: turn.userMessage });
      if (turn.agentResponse) history.push({ role: 'assistant', content: turn.agentResponse });
    });

    try {
      sessionStorage.setItem(SESSION_KEY, id);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      /* the conversation still works for this page view */
    }

    repaint();

    // Drafts come back after the transcript, at the end. Their exact position
    // in the conversation is not recorded, and pretending to know it would put
    // an email above the message that asked for it. Listed at the bottom they
    // are plainly "what this conversation wrote", which is what a rep coming
    // back to it wants.
    (drafts || []).forEach(addDraft);

    emit('session', id);
    input.focus();
  }

  resetBtn.addEventListener('click', newChat);

  function open() {
    panel.classList.remove('vk-hidden');
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
  }

  function close() {
    panel.classList.add('vk-hidden');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  launcher.addEventListener('click', open);
  closeBtn.addEventListener('click', close);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && MODE === 'float' && !panel.classList.contains('vk-hidden')) {
      close();
    }
  });

  // --- Identity ------------------------------------------------------------

  // Cosmetic only — the backend is the authority on identity. This just tells
  // the rep which account they are signed in as.
  function loadIdentity() {
    fetch(ENDPOINT + '/whoami', { credentials: 'include' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (me) {
        if (me && me.email) sub.textContent = 'Internal · ' + me.email + ' · logged';
      })
      .catch(function () {
        /* leave the default subtitle */
      });
  }

  // --- Mount ---------------------------------------------------------------

  function mount() {
    var host = document.body;
    if (MODE === 'inline') {
      host = MOUNT ? document.querySelector(MOUNT) : null;
      if (!host) {
        console.error('[vikat-chat] data-mode="inline" needs a data-mount selector that resolves.');
        return;
      }
    }
    host.appendChild(root);

    history = loadHistory();
    repaint();
    autosize();
    loadIdentity();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // Test hooks. splitTags decides whether a rep sees "Internal only" or nothing
  // at all, and renderBody turns model output into DOM — both are worth
  // asserting on directly rather than through a live conversation. Exposed
  // deliberately; neither reads module state.
  /**
   * What the app shell around this widget is allowed to use.
   *
   * Deliberately small: the widget owns the conversation and the rails read
   * from it, never the other way round. A rail that wrote history directly
   * would be a second owner of the same state.
   */
  window.VikatChat = {
    newChat: newChat,
    open: openChat,
    sessionId: sessionId,
    on: on,
  };

  window.VikatChatInternals = {
    splitTags: splitTags,
    renderBody: renderBody,
    emitForTest: emit,
    // The card is what a rep actually touches, so it is drivable from a test
    // without having to fake a whole streamed turn.
    addDraft: addDraft,
  };
})();
