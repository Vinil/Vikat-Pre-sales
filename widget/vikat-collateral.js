/**
 * vikat-collateral.js — tab switching, and the Collateral browser.
 *
 * The collateral list is the SharePoint material the nightly sync indexed:
 * one row per file, with the summary the sync generated, linking straight to
 * the document in SharePoint. Search is client-side over the whole index —
 * the corpus is a few hundred documents at most, so filtering in the browser
 * is instant and costs no round-trip per keystroke.
 */

(function () {
  'use strict';

  var script = document.currentScript;
  var RAW_ENDPOINT = script && script.getAttribute('data-endpoint');
  var ENDPOINT = (RAW_ENDPOINT || '').replace(/\/+$/, '');

  var $ = function (s) { return document.querySelector(s); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // --- Tabs ----------------------------------------------------------------

  var TABS = ['chat', 'collateral'];
  var loaded = false;

  function tabFromHash() {
    var h = location.hash.slice(1);
    return TABS.indexOf(h) !== -1 ? h : 'chat';
  }

  function selectTab(name) {
    TABS.forEach(function (t) {
      var active = t === name;
      $('#tab-' + t).setAttribute('aria-selected', String(active));
      $('#pane-' + t).hidden = !active;
    });

    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);

    // Load the index on first view rather than at boot — a rep who never opens
    // the tab should not pay for it.
    if (name === 'collateral' && !loaded) load();
    if (name === 'collateral') $('#col-search').focus();
  }

  TABS.forEach(function (t) {
    $('#tab-' + t).addEventListener('click', function () { selectTab(t); });
  });

  // The hash is the tab, so an externally-changed hash must move the tab:
  // a pasted #collateral link into an open page, or an edited address bar,
  // otherwise leaves the URL and the view disagreeing.
  window.addEventListener('hashchange', function () { selectTab(tabFromHash()); });

  document.querySelector('nav').addEventListener('keydown', function (e) {
    var i = TABS.indexOf(tabFromHash());
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      var next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      selectTab(next);
      $('#tab-' + next).focus();
    }
  });

  // --- Collateral ----------------------------------------------------------

  /** @type {{name:string,summary:string,webUrl:string,kind:string,modified:string,folder:string}[]} */
  var docs = [];

  function kindOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'pptx' || ext === 'ppt') return 'pptx';
    if (ext === 'docx' || ext === 'doc') return 'docx';
    if (ext === 'pdf') return 'pdf';
    return 'other';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function render(list) {
    var box = $('#col-list');
    box.textContent = '';

    $('#col-count').textContent = docs.length
      ? list.length + ' of ' + docs.length
      : '';

    if (docs.length === 0) {
      var empty = el('div', 'state');
      empty.appendChild(el('b', null, 'No collateral indexed yet.'));
      empty.appendChild(document.createTextNode(
        'Documents appear here once the SharePoint sync has run. Ask an admin to check the sync settings.',
      ));
      box.appendChild(empty);
      return;
    }

    if (list.length === 0) {
      var none = el('div', 'state');
      none.appendChild(el('b', null, 'Nothing matches that.'));
      none.appendChild(document.createTextNode('Try a product name, a customer, or a topic.'));
      box.appendChild(none);
      return;
    }

    list.forEach(function (d) {
      var a = el('a', 'doc');
      a.href = d.webUrl || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      a.appendChild(el('div', 'doc-name', d.name));
      if (d.summary) a.appendChild(el('div', 'doc-summary', d.summary));

      var meta = el('div', 'doc-meta');
      meta.appendChild(el('span', 'kind kind-' + kindOf(d.name), kindOf(d.name)));
      if (d.folder) meta.appendChild(el('span', null, d.folder));
      if (d.modified) meta.appendChild(el('span', null, 'Updated ' + fmtDate(d.modified)));
      a.appendChild(meta);

      box.appendChild(a);
    });
  }

  /** Match every term, across name, summary and folder. */
  function filter(query) {
    var terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return docs;

    return docs.filter(function (d) {
      var hay = ((d.name || '') + ' ' + (d.summary || '') + ' ' + (d.folder || '')).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  var debounce = null;
  $('#col-search').addEventListener('input', function (e) {
    clearTimeout(debounce);
    var v = e.target.value;
    debounce = setTimeout(function () { render(filter(v)); }, 90);
  });

  function load() {
    loaded = true;
    fetch(ENDPOINT + '/collateral', { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (data) {
        docs = (data.documents || []).slice().sort(function (a, b) {
          return String(b.modified || '').localeCompare(String(a.modified || ''));
        });
        render(filter($('#col-search').value));
      })
      .catch(function () {
        loaded = false; // let a tab revisit retry
        var box = $('#col-list');
        box.textContent = '';
        var err = el('div', 'state');
        err.appendChild(el('b', null, 'Could not load collateral.'));
        err.appendChild(document.createTextNode('Reload the page, or try again shortly.'));
        box.appendChild(err);
      });
  }

  // --- Identity ------------------------------------------------------------

  fetch(ENDPOINT + '/whoami', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (me && me.email) $('#who').textContent = me.email + ' · logged';
    })
    .catch(function () {});

  // --- Boot ----------------------------------------------------------------

  selectTab(tabFromHash());
})();
