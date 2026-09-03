/**
 * The two rails either side of the conversation.
 *
 * Left: the rep's own chats, from GET /chats, plus a way to start a new one.
 * Right: what this conversation produced or surfaced.
 *
 * Both read from the chat widget and never write to it. The widget owns the
 * conversation; window.VikatChat is the whole surface it offers, and going
 * around it — writing sessionStorage from here, say — would make this a second
 * owner of the same state and the two would drift.
 */
(function () {
  'use strict';

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Dates a rep reads at a glance, not timestamps they have to parse. */
  function when(iso) {
    if (!iso) return '';
    var then = new Date(iso);
    if (isNaN(then)) return '';

    var mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
    if (mins < 60 * 24 * 7) return Math.round(mins / 1440) + 'd ago';
    return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, options || {})).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  // --- Collapsing ----------------------------------------------------------

  /**
   * Remembered per viewer, per rail.
   *
   * A rep who closes the assets rail has decided their screen is narrow or
   * their work is elsewhere; reopening it on every page load overrules them
   * once a day forever.
   */
  function wireToggle(button, shutClass, storageKey) {
    var pane = $('#pane-chat');

    function apply(shut) {
      pane.classList.toggle(shutClass, shut);
      button.setAttribute('aria-expanded', shut ? 'false' : 'true');
      button.title = (shut ? 'Show ' : 'Hide ') + button.textContent.trim().toLowerCase();
    }

    var stored = null;
    try {
      stored = localStorage.getItem(storageKey);
    } catch (e) {
      /* blocked storage: the rail simply opens each time */
    }
    apply(stored === 'shut');

    button.addEventListener('click', function () {
      var shut = !pane.classList.contains(shutClass);
      apply(shut);
      try {
        localStorage.setItem(storageKey, shut ? 'shut' : 'open');
      } catch (e) {
        /* the toggle still works for this page view */
      }
    });
  }

  // --- Left rail: conversations -------------------------------------------

  var chatsBody = $('#chats-body');
  var currentId = null;

  function renderChats(chats) {
    chatsBody.textContent = '';

    if (!chats.length) {
      chatsBody.appendChild(
        el('div', 'rail-empty', 'Your conversations will be listed here once you have had one.'),
      );
      return;
    }

    chats.forEach(function (chat) {
      var item = el('button', 'rail-item');
      item.type = 'button';
      if (chat.sessionId === currentId) item.setAttribute('aria-current', 'true');

      item.appendChild(el('div', 't', chat.title || 'Untitled'));
      var meta = when(chat.updatedAt);
      if (meta) item.appendChild(el('div', 'd', meta));

      item.addEventListener('click', function () {
        if (chat.sessionId === currentId) return;
        openChat(chat.sessionId);
      });

      chatsBody.appendChild(item);
    });
  }

  function loadChats() {
    return api('/chats')
      .then(function (r) {
        renderChats(r.chats || []);
      })
      .catch(function () {
        chatsBody.textContent = '';
        chatsBody.appendChild(el('div', 'rail-empty', 'Could not load your conversations.'));
      });
  }

  function openChat(id) {
    // The transcript comes from the server, which is what lets a rep pick a
    // conversation up on a different machine than they started it on. Its
    // assets come with it, for the same reason.
    api('/chats/' + encodeURIComponent(id))
      .then(function (r) {
        window.VikatChat.open(id, r.turns || [], r.drafts || []);
        resetAssets();
        addAssets(r.assets || []);
      })
      .catch(function () {
        chatsBody.appendChild(el('div', 'rail-empty', 'That conversation could not be opened.'));
      });
  }

  /**
   * Put back what the conversation already produced.
   *
   * Called on load as well as on switching chats. A refresh used to empty the
   * rail while the transcript survived in sessionStorage, so the rep was
   * looking at a conversation that had plainly built them a deck and a rail
   * that said none had been built.
   *
   * A brand-new session has no server record yet and 404s; that is the empty
   * rail, not an error worth showing.
   */
  function restoreAssets(id) {
    if (!id) return;
    api('/chats/' + encodeURIComponent(id))
      .then(function (r) {
        addAssets(r.assets || []);
      })
      .catch(function () {});
  }

  // --- Right rail: assets --------------------------------------------------

  var assetsBody = $('#assets-body');
  var assetsCount = $('#assets-count');
  var assets = { generated: [], collateral: [], web: [] };

  function resetAssets() {
    assets = { generated: [], collateral: [], web: [] };
    renderAssets();
  }

  function renderAssets() {
    assetsBody.textContent = '';
    var total = assets.generated.length + assets.collateral.length + assets.web.length;
    assetsCount.textContent = total ? String(total) : '';

    if (!total) {
      assetsBody.appendChild(
        el('div', 'rail-empty', 'Documents built and collateral found in this conversation collect here.'),
      );
      return;
    }

    if (assets.generated.length) {
      assetsBody.appendChild(el('div', 'asset-group', 'Generated'));
      assets.generated.forEach(function (a) {
        assetsBody.appendChild(generatedCard(a));
      });
    }

    if (assets.collateral.length) {
      assetsBody.appendChild(el('div', 'asset-group', 'Referenced'));
      assets.collateral.forEach(function (a) {
        assetsBody.appendChild(collateralCard(a));
      });
    }

    if (assets.web.length) {
      // Its own group, and named for where it came from. A page the assistant
      // read on the open web is not our material and must never sit in a list
      // that implies it is.
      assetsBody.appendChild(el('div', 'asset-group', 'From the web'));
      assets.web.forEach(function (a) {
        assetsBody.appendChild(webCard(a));
      });
    }
  }

  function webCard(a) {
    var card = el('a', 'asset');
    card.href = a.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.appendChild(el('div', 'n', a.name));

    var meta = el('div', 'm');
    meta.appendChild(el('span', 'warn', 'External source'));
    var host = '';
    try {
      host = new URL(a.url).hostname.replace(/^www\./, '');
    } catch (e) {
      /* a malformed url still gets a card, just without the host */
    }
    if (host) {
      meta.appendChild(document.createTextNode(' \u00b7 ' + host));
    }
    card.appendChild(meta);

    return card;
  }

  function generatedCard(a) {
    var card = el('a', 'asset');
    card.href = a.url;
    card.appendChild(el('div', 'n', a.name));

    var meta = el('div', 'm');
    // The disclosure label is the one thing a rep must see before sending a
    // file to a customer, so it sits on the card rather than in the answer
    // text they may have scrolled past.
    if (a.disclosure) {
      var isInternal = /internal/i.test(a.disclosure);
      meta.appendChild(el('span', isInternal ? 'warn' : null, a.disclosure));
    }
    if (a.sharePointUrl) {
      if (meta.childNodes.length) meta.appendChild(document.createTextNode(' · '));
      var sp = el('a', null, 'SharePoint');
      sp.href = a.sharePointUrl;
      sp.target = '_blank';
      sp.rel = 'noopener noreferrer';
      meta.appendChild(sp);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    return card;
  }

  function collateralCard(a) {
    var card = el('a', 'asset');
    card.href = a.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.appendChild(el('div', 'n', a.name));

    var bits = [];
    if (a.folder) bits.push(a.folder);
    if (a.modified) bits.push('updated ' + when(a.modified));
    if (bits.length) card.appendChild(el('div', 'm', bits.join(' · ')));

    return card;
  }

  function addAssets(incoming) {
    (incoming || []).forEach(function (a) {
      if (!a || !a.url || !a.name) return;
      var bucket = assets[a.kind === 'generated' ? 'generated' : a.kind === 'web' ? 'web' : 'collateral'];
      // The same deck surfaced twice in one conversation is one asset.
      if (bucket.some(function (existing) { return existing.url === a.url; })) return;
      bucket.push(a);
    });
    renderAssets();
  }

  // --- Wiring --------------------------------------------------------------

  function boot() {
    if (!window.VikatChat) {
      // vikat-chat.js is what owns the conversation; without it the rails have
      // nothing to show and no way to change anything.
      console.error('[rails] VikatChat is not present — the rails need it to work.');
      return;
    }

    wireToggle($('#chats-tog'), 'l-shut', 'vikat.rail.chats');
    wireToggle($('#assets-tog'), 'r-shut', 'vikat.rail.assets');

    currentId = window.VikatChat.sessionId();

    $('#chats-new').addEventListener('click', function () {
      window.VikatChat.newChat();
      resetAssets();
    });

    window.VikatChat.on('asset', addAssets);

    window.VikatChat.on('session', function (id) {
      currentId = id;
      loadChats();
    });

    // A new conversation is only indexed once its first turn completes, so the
    // list is refreshed then rather than on send.
    window.VikatChat.on('turn', function (id) {
      currentId = id;
      loadChats();
    });

    renderAssets();
    loadChats();
    restoreAssets(currentId);
  }

  // vikat-chat.js is loaded after this file, so wait for it rather than racing.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
