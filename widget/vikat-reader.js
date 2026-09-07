/**
 * vikat-reader.js — read a document beside the conversation.
 *
 * A rep who has just had a deck built has one question: is this any good? The
 * answer used to require downloading it, opening PowerPoint, looking, coming
 * back and typing. Every one of those steps is a place the thought gets lost,
 * and the assistant that could fix the slide is three windows away by the time
 * they know which slide it is.
 *
 * So the document opens in the middle of the app and the conversation moves to
 * the right of it. Nothing else changes: the same chat, the same session, the
 * same rails. It is the same screen with the document in it.
 *
 * What can actually be shown is honest rather than aspirational. A PDF renders
 * in place, because a browser can render a PDF and the Worker will serve one
 * inline. A .pptx or .docx cannot be rendered by any browser, so it gets a
 * sheet that says what it is, what is printed on it, and where to open it —
 * which is more than the rail said and does not pretend to be the file.
 */

(function () {
  'use strict';

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  var work = $('#work');
  var reader = $('#reader');
  if (!work || !reader) return;

  var titleEl = $('#reader-title');
  var kindEl = $('#reader-kind');
  var noteEl = $('#reader-note');
  var surface = $('#reader-surface');
  var downloadEl = $('#reader-download');
  var closeEl = $('#reader-close');

  /** The asset on screen, or null. */
  var current = null;
  /** Whether the assets rail was already shut before reading opened it. */
  var railWasShut = false;

  /**
   * Only a path this app serves.
   *
   * The reader mounts a URL into an iframe, which is the one place in this
   * widget where a value from the server becomes something the browser
   * executes against. Generated documents are always /document/doc_… and
   * nothing else is embeddable, so anything else is refused rather than
   * sanitised: a reader that guesses is worse than a download link.
   */
  function embeddable(url) {
    return typeof url === 'string' && /^\/document\/doc_[a-f0-9]{16}$/.test(url);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** A sheet for a file the browser cannot render. */
  function sheet(asset) {
    var page = el('div', 'reader-sheet');
    page.appendChild(el('div', 'reader-sheet-kind', (asset.format || 'file').toUpperCase()));
    page.appendChild(el('h2', 'reader-sheet-name', asset.name || 'Document'));
    page.appendChild(
      el(
        'p',
        'reader-sheet-why',
        'No browser can render this format in a page. It is built and saved; open it to read it.',
      ),
    );

    if (asset.disclosure) {
      page.appendChild(el('div', 'reader-sheet-disclosure', asset.disclosure));
    }

    var row = el('div', 'reader-sheet-row');
    var dl = el('a', 'reader-sheet-btn', 'Download');
    dl.href = asset.url;
    row.appendChild(dl);

    if (asset.sharePointUrl) {
      var sp = el('a', 'reader-sheet-btn ghost', 'Open in SharePoint');
      sp.href = asset.sharePointUrl;
      sp.target = '_blank';
      sp.rel = 'noopener noreferrer';
      row.appendChild(sp);
    }
    page.appendChild(row);

    return page;
  }

  /**
   * Open `asset` in the middle of the app.
   *
   * @param {{name:string,url:string,format?:string,disclosure?:string,sharePointUrl?:string}} asset
   */
  function open(asset) {
    if (!asset || !embeddable(asset.url)) return false;

    current = asset;
    titleEl.textContent = asset.name || 'Document';
    kindEl.textContent = (asset.format || '').toUpperCase();
    kindEl.hidden = !asset.format;

    // The disclosure is the one thing a rep must see before sending a file,
    // so it sits in the toolbar of the thing they are looking at rather than
    // in a rail they opened this to get away from.
    noteEl.textContent = asset.disclosure || '';
    noteEl.hidden = !asset.disclosure;
    noteEl.className = /internal/i.test(asset.disclosure || '') ? 'reader-note warn' : 'reader-note';

    downloadEl.href = asset.url;
    downloadEl.setAttribute('download', asset.name || '');

    clear(surface);
    if (asset.format === 'pdf') {
      var frame = el('iframe', 'reader-page');
      // ?view=1 asks the Worker for Content-Disposition: inline, which it
      // grants for a PDF and refuses for anything else. Without it the browser
      // downloads the file instead of drawing it.
      frame.src = asset.url + '?view=1#toolbar=0&navpanes=0&view=FitH';
      frame.title = asset.name || 'Document';
      surface.appendChild(frame);
    } else {
      surface.appendChild(sheet(asset));
    }

    // The conversation needs room beside the page, and the assets rail is
    // where the rep just clicked from. Remembered, so closing the reader gives
    // back the rail they had rather than the rail this decided they wanted.
    var pane = $('#pane-chat');
    // Only on the way IN. Opening a second document while the first is on
    // screen would otherwise read the rail this closed and conclude the rep
    // had closed it, so closing the reader would leave it shut for good.
    if (reader.hidden) railWasShut = pane.classList.contains('r-shut');
    pane.classList.add('r-shut');

    work.classList.add('reading');
    reader.hidden = false;
    closeEl.focus();
    mark();
    return true;
  }

  function close() {
    if (reader.hidden) return;
    current = null;
    work.classList.remove('reading');
    reader.hidden = true;
    // An iframe left in the DOM keeps the document loaded and the plugin
    // alive. Emptying it is what actually closes the file.
    clear(surface);
    if (!railWasShut) $('#pane-chat').classList.remove('r-shut');
    mark();
  }

  /** Show which asset is open, so the rail and the page agree. */
  function mark() {
    var cards = document.querySelectorAll('#assets-body .asset');
    for (var i = 0; i < cards.length; i += 1) {
      var open_ = current && cards[i].getAttribute('href') === current.url;
      if (open_) cards[i].setAttribute('aria-current', 'true');
      else cards[i].removeAttribute('aria-current');
    }
  }

  closeEl.addEventListener('click', close);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !reader.hidden) close();
  });

  window.VikatReader = { open: open, close: close, mark: mark, embeddable: embeddable };
})();
