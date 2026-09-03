/**
 * vikat-admin.js — admin panel for the Vikat sales assistant.
 *
 * Vanilla JS, no dependencies. Same embed contract as the widget: the backend
 * URL comes from data-endpoint, so moving the Worker is a one-line change.
 *
 * Every route it calls requires the admin role. The Worker is the authority —
 * nothing here is a security control, it is a user interface over one.
 */

(function () {
  'use strict';

  var script = document.currentScript;
  // data-endpoint="/" means same-origin, which is how this is deployed.
  var RAW_ENDPOINT = script && script.getAttribute('data-endpoint');
  var ENDPOINT = (RAW_ENDPOINT || '').replace(/\/+$/, '');

  if (RAW_ENDPOINT === null || RAW_ENDPOINT === undefined) {
    console.error('[vikat-admin] data-endpoint is required. Use "/" for same-origin.');
    return;
  }

  // --- Helpers -------------------------------------------------------------

  var $ = function (sel) { return document.querySelector(sel); };

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('#toast');
    t.textContent = message;
    t.classList.toggle('err', Boolean(isError));
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, isError ? 6000 : 3000);
  }

  /**
   * Call the admin API.
   *
   * Errors surface as toasts and reject, so callers can skip their success path
   * without each writing its own error handling.
   */
  async function api(path, options) {
    var opts = options || {};
    var res;

    try {
      res = await fetch(ENDPOINT + path, {
        method: opts.method || 'GET',
        credentials: 'include',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      toast('Could not reach the server. Check your connection.', true);
      throw e;
    }

    var payload = null;
    try { payload = await res.json(); } catch (e) { /* empty or non-JSON body */ }

    if (!res.ok) {
      if (res.status === 401) {
        signInAgain(payload);
      } else if (res.status === 403) {
        // The server says WHY. It knows whether this is the wrong account, a
        // missing role, or an identity provider that never sent an email
        // address, and those need different things done about them.
        renderForbidden(payload && payload.error);
      } else {
        toast((payload && payload.error) || ('Request failed (' + res.status + ')'), true);
      }
      throw new Error((payload && payload.error) || res.status);
    }

    clearReauth();
    return payload;
  }

  /**
   * Reload once, and only for a rejection a fresh sign-in can actually fix.
   *
   * This used to fire on EVERY 401 and always reload. When the cause was
   * something signing in again cannot change — the wrong account, a
   * misconfigured audience — the reload produced the identical rejection and
   * scheduled another one. An admin who had just signed in successfully sat
   * watching "Your session expired. Reloading…" every second and a half.
   */
  var reloading = false;
  var TRIED = 'vikat.admin.reauth';

  function signInAgain(payload) {
    var message = (payload && payload.error) || 'Sign in with your Vikat account.';

    // `retry: 'never'` means the server has already established that another
    // round trip lands in the same place.
    if (payload && payload.retry === 'never') {
      renderForbidden(message);
      return;
    }

    // Reloading is worth ONE attempt, and the record of that attempt has to
    // survive the reload to be worth anything. A wrong CF_ACCESS_AUD rejects a
    // perfectly good Access cookie as an invalid token — a real 401 that a
    // real sign-in cannot fix: reload, same cookie, same rejection, reload. An
    // in-memory flag resets on every page load and would leave that loop
    // spinning exactly as before.
    var tried = false;
    try {
      tried = sessionStorage.getItem(TRIED) === '1';
    } catch (e) {
      // Storage blocked. Better never to auto-reload than to loop; the
      // message still says what to do.
      tried = true;
    }

    if (tried || reloading) {
      clearReauth();
      renderForbidden(
        message +
          ' Signing in again did not help, so this is not a stale session — ask whoever deployed ' +
          'the assistant to check the Cloudflare Access application.',
      );
      return;
    }

    reloading = true;
    try { sessionStorage.setItem(TRIED, '1'); } catch (e) { /* the one attempt still happens */ }
    toast(message + ' Reloading…', true);
    setTimeout(function () { location.reload(); }, 1500);
  }

  /** A call that succeeded means the sign-in worked; forget the attempt. */
  function clearReauth() {
    try { sessionStorage.removeItem(TRIED); } catch (e) { /* nothing to clear */ }
  }

  function renderForbidden(message) {
    document.querySelector('main').textContent = '';
    var h = document.createElement('h1');
    h.textContent = 'Not available';
    var p = document.createElement('p');
    p.className = 'lede';
    p.textContent =
      message ||
      'Your account does not have administrator access to the sales assistant. Ask an existing admin to grant it.';
    document.querySelector('main').appendChild(h);
    document.querySelector('main').appendChild(p);
  }

  function fmtDate(iso) {
    if (!iso) return 'never';
    var d = new Date(iso);
    if (isNaN(d)) return 'unknown';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // --- Tabs ----------------------------------------------------------------

  var TABS = ['knowledge', 'sharepoint', 'users'];

  function selectTab(name) {
    TABS.forEach(function (t) {
      var tab = $('#tab-' + t);
      var panel = $('#panel-' + t);
      var active = t === name;
      tab.setAttribute('aria-selected', String(active));
      panel.hidden = !active;
    });
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  }

  TABS.forEach(function (t) {
    $('#tab-' + t).addEventListener('click', function () { selectTab(t); });
  });

  // Arrow-key navigation between tabs, per the ARIA tabs pattern.
  $('.tabs').addEventListener('keydown', function (e) {
    var i = TABS.indexOf(location.hash.slice(1));
    if (i === -1) i = 0;
    if (e.key === 'ArrowRight') { e.preventDefault(); var n = TABS[(i + 1) % TABS.length]; selectTab(n); $('#tab-' + n).focus(); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); var p = TABS[(i - 1 + TABS.length) % TABS.length]; selectTab(p); $('#tab-' + p).focus(); }
  });

  // --- Knowledge -----------------------------------------------------------

  function renderKnowledge(entries) {
    var list = $('#kb-list');
    list.textContent = '';

    var approved = entries.filter(function (e) { return e.status === 'approved'; }).length;
    $('#kb-count').textContent =
      entries.length ? '· ' + approved + ' live of ' + entries.length : '';

    if (entries.length === 0) {
      list.appendChild(el('div', 'empty', 'Nothing yet. Add the answers reps keep asking for.'));
      return;
    }

    entries.forEach(function (entry) {
      var row = el('div', 'item');

      var main = el('div', 'item-main');
      var titleRow = el('div', 'item-title');
      titleRow.appendChild(document.createTextNode(entry.section + ' '));
      titleRow.appendChild(
        el('span', 'pill pill-' + (entry.status === 'approved' ? 'approved' : 'draft'),
           entry.status === 'approved' ? 'Live' : 'Draft'),
      );
      main.appendChild(titleRow);
      main.appendChild(el('div', 'item-body', entry.content));
      main.appendChild(
        el('div', 'item-meta', 'Updated ' + fmtDate(entry.updatedAt) + ' by ' + (entry.updatedBy || 'unknown')),
      );

      var actions = el('div', 'item-actions');

      var edit = el('button', 'ghost', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', function () { startEdit(entry); });

      var del = el('button', 'danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', function () {
        // A confirm() is crude, but deleting knowledge silently changes what
        // the assistant tells the whole team.
        if (!confirm('Delete "' + entry.section + '"? The assistant will stop using it immediately.')) return;
        api('/admin/knowledge?id=' + encodeURIComponent(entry.id), { method: 'DELETE' })
          .then(function () { toast('Deleted.'); loadKnowledge(); })
          .catch(function () {});
      });

      actions.appendChild(edit);
      actions.appendChild(del);

      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function startEdit(entry) {
    $('#kb-id').value = entry.id;
    $('#kb-section').value = entry.section;
    $('#kb-content').value = entry.content;
    $('#kb-status').value = entry.status;
    $('#kb-notes').value = entry.notes || '';
    $('#kb-form-heading').textContent = 'Edit knowledge';
    $('#kb-save').textContent = 'Update entry';
    $('#kb-cancel').hidden = false;
    $('#kb-section').focus();
    $('#kb-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetKnowledgeForm() {
    $('#kb-form').reset();
    $('#kb-id').value = '';
    $('#kb-form-heading').textContent = 'Add knowledge';
    $('#kb-save').textContent = 'Save entry';
    $('#kb-cancel').hidden = true;
  }

  $('#kb-cancel').addEventListener('click', resetKnowledgeForm);

  $('#kb-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var save = $('#kb-save');
    save.disabled = true;

    var body = {
      section: $('#kb-section').value,
      content: $('#kb-content').value,
      status: $('#kb-status').value,
      notes: $('#kb-notes').value,
    };
    var id = $('#kb-id').value;
    if (id) body.id = id;

    api('/admin/knowledge', { method: 'POST', body: body })
      .then(function (r) {
        toast(
          r.entry.status === 'approved'
            ? 'Saved and live — the assistant will use it on the next message.'
            : 'Saved as a draft. Set it to approved to make it live.',
        );
        resetKnowledgeForm();
        loadKnowledge();
      })
      .catch(function () {})
      .then(function () { save.disabled = false; });
  });

  function loadKnowledge() {
    return api('/admin/knowledge')
      .then(function (r) { renderKnowledge(r.entries || []); })
      .catch(function () {});
  }

  // --- Positioning ---------------------------------------------------------

  var posMax = 24000;

  function posCount() {
    var n = $('#pos-content').value.length;
    $('#pos-count').textContent =
      n + ' / ' + posMax.toLocaleString() + ' characters' + (n >= posMax ? ' — at the limit' : '');
  }

  function showPositioning(r) {
    if (typeof r.content === 'string') $('#pos-content').value = r.content;
    if (r.sourceName) $('#pos-source').value = r.sourceName;
    if (r.maxChars) posMax = r.maxChars;
    if (r.accepts) $('#pos-accepts').textContent = 'Accepts ' + r.accepts.join(', ') + '.';

    $('#pos-meta').textContent = r.updatedAt
      ? 'Last saved ' + fmtDate(r.updatedAt) + (r.updatedBy ? ' by ' + r.updatedBy : '') + '.'
      : 'Nothing saved yet — the assistant is answering from the knowledge base alone.';

    posCount();
  }

  function loadPositioning() {
    return api('/admin/positioning').then(showPositioning);
  }

  $('#pos-content').addEventListener('input', posCount);

  $('#pos-file').addEventListener('change', function () {
    var input = $('#pos-file');
    if (!input.files || !input.files[0]) return;

    var body = new FormData();
    body.append('file', input.files[0]);

    var status = $('#pos-status');
    status.textContent = 'Reading ' + input.files[0].name + '…';

    // Not through api(): that helper JSON-encodes its body, and multipart must
    // set its own boundary.
    fetch(ENDPOINT + '/admin/positioning', { method: 'POST', credentials: 'include', body: body })
      .then(function (res) {
        return res.json().then(function (payload) { return { res: res, payload: payload }; });
      })
      .then(function (r) {
        if (!r.res.ok) throw new Error((r.payload && r.payload.error) || 'Could not read that file');

        // Fills the box. Deliberately does NOT save: this text governs every
        // answer the assistant gives, and nothing should govern every answer
        // without a person having read it.
        $('#pos-content').value = r.payload.content || '';
        $('#pos-source').value = r.payload.sourceName || '';
        posCount();

        status.textContent = r.payload.note || 'Read. Check it, then Save.';
        (r.payload.warnings || []).forEach(function (w) { toast(w, true); });
      })
      .catch(function (err) {
        status.textContent = '';
        toast(err.message || 'Could not read that file', true);
      })
      .finally(function () {
        input.value = '';
      });
  });

  $('#pos-save').addEventListener('click', function () {
    var btn = $('#pos-save');
    btn.disabled = true;

    api('/admin/positioning', {
      method: 'PUT',
      body: { content: $('#pos-content').value, sourceName: $('#pos-source').value },
    })
      .then(function (r) {
        toast(r.note || 'Saved.');
        showPositioning(r);
      })
      .catch(function () {})
      .finally(function () { btn.disabled = false; });
  });

  $('#pos-clear').addEventListener('click', function () {
    // A wrong positioning statement governing every answer is worse than none,
    // so clearing has to be one obvious action rather than select-all-delete.
    if (!window.confirm('Clear the positioning statement? The assistant will answer from the knowledge base alone.')) {
      return;
    }
    $('#pos-content').value = '';
    $('#pos-source').value = '';
    posCount();
    $('#pos-save').click();
  });

  // --- Upload --------------------------------------------------------------

  function loadUploadTargets() {
    return api('/admin/upload')
      .then(function (r) {
        $('#up-accepts').textContent =
          'Accepts ' + (r.accepts || []).join(', ') + ', up to ' + Math.round((r.maxBytes || 0) / 1024) + 'KB.' +
          (r.pdfReader === 'model'
            // Office files are unzipped locally and cost nothing; a PDF is read
            // by the model. Worth knowing before uploading fifty of them.
            ? ' PDFs are read by the model, which takes longer and uses tokens.'
            : ' PDFs are read locally, so a scanned one cannot be read at all.');
        $('#up-file').setAttribute('accept', (r.accepts || []).join(','));

        var select = $('#up-library');
        select.textContent = '';

        var libraries = r.libraries || [];
        if (libraries.length === 0) {
          // Graph is not reachable or not configured. Say so on the control it
          // affects rather than leaving an empty dropdown to be puzzled over.
          var none = el('option', null, 'SharePoint unavailable — ' + (r.sharePoint || 'unknown'));
          none.value = '';
          select.appendChild(none);
          select.disabled = true;
          $('#up-folder-hint').textContent =
            'The file will still be read into the assistant’s knowledge; it just will not be filed.';
          return;
        }

        select.disabled = false;
        libraries.forEach(function (name) {
          var opt = el('option', null, name);
          opt.value = name;
          if (name === r.defaultLibrary) opt.selected = true;
          select.appendChild(opt);
        });

        if (r.reservedFolder) {
          $('#up-folder-hint').textContent =
            'Where in the library it belongs. Leave blank for the top level. "' +
            r.reservedFolder +
            '" is reserved for the assistant’s own output and is not read back.';
        }
      })
      .catch(function () {});
  }

  $('#up-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var input = $('#up-file');
    if (!input.files || !input.files[0]) return;

    var body = new FormData();
    body.append('file', input.files[0]);
    body.append('library', $('#up-library').value);
    body.append('folder', $('#up-folder').value);

    var submit = $('#up-submit');
    var status = $('#up-status');
    submit.disabled = true;
    // Reading a deck takes a moment and the button going quiet looks like
    // nothing happening, which is how someone ends up uploading it twice.
    var isPdf = /\.pdf$/i.test(input.files[0].name);
    status.textContent = isPdf
      // A PDF goes to the model, which takes longer than unzipping a deck and
      // costs tokens. Both are worth saying before the wait, not after.
      ? 'Reading ' + input.files[0].name + ' with the model — this takes a moment and uses tokens…'
      : 'Reading ' + input.files[0].name + '…';

    // Not through api(): that helper JSON-encodes its body, and multipart must
    // set its own boundary.
    fetch(ENDPOINT + '/admin/upload', { method: 'POST', credentials: 'include', body: body })
      .then(function (res) {
        return res.json().then(function (payload) { return { res: res, payload: payload }; });
      })
      .then(function (r) {
        if (!r.res.ok) throw new Error((r.payload && r.payload.error) || 'Upload failed');

        toast(r.payload.note || 'Uploaded.');

        var said = r.payload.chunks + ' passage(s) added' + (r.payload.filed ? ' and filed in SharePoint.' : '.');
        var usage = r.payload.usage;
        if (r.payload.reader === 'model' && usage) {
          // Printed rather than assumed: this is the one upload that spends
          // money, and an admin should see how much before doing it fifty
          // times.
          said +=
            ' Read by the model' +
            (usage.pages ? ' (~' + usage.pages + ' pages, ' : ' (') +
            (usage.inputTokens || 0).toLocaleString() +
            ' in / ' +
            (usage.outputTokens || 0).toLocaleString() +
            ' out tokens).';
        }
        status.textContent = said;

        // A truncated transcript or a fallback to the byte extractor is not a
        // failure, but the admin has to know it happened.
        (r.payload.warnings || []).forEach(function (w) { toast(w, true); });
        $('#up-form').reset();
        loadUploadTargets();
        loadKnowledge();
      })
      .catch(function (err) {
        status.textContent = '';
        toast(err.message || 'Upload failed', true);
      })
      .finally(function () {
        submit.disabled = false;
      });
  });

  // --- SharePoint ----------------------------------------------------------

  function loadSharePoint() {
    return api('/admin/sharepoint')
      .then(function (r) { renderSharePoint(r); })
      .catch(function () {});
  }

  function renderSharePoint(data) {
    var scope = data.scope || {};

    function put(id, value) {
      var node = $(id);
      node.textContent = value || 'not set';
      node.className = value ? '' : 'unset';
    }

    put('#sp-hostname', scope.hostname);
    put('#sp-sitepath', scope.sitePath);
    put('#sp-library', scope.library);
    put('#sp-genfolder', scope.generatedFolder);

    $('#sp-scope-note').textContent = scope.note || '';
    $('#sp-scope-where').textContent = scope.managedBy
      ? 'Configured in ' + scope.managedBy + '. Change it there, then re-run the "Sync knowledge base" workflow.'
      : '';

    // Two credential sets, reported separately. Conflating them is how this
    // banner came to announce "the sync will not run" while the sync ran fine.
    var cred = data.credentials || {};
    var filing = cred.documentFiling || {};
    var banner = $('#sp-credentials');
    banner.textContent = '';
    banner.className = 'banner ' + (filing.configured ? 'banner-ok' : 'banner-warn');

    banner.appendChild(el('strong', null, filing.configured
      ? 'Document filing is configured.'
      : 'Document filing is not configured.'));
    banner.appendChild(document.createTextNode(' ' + (filing.affects || '') + ' '));
    banner.appendChild(document.createTextNode(
      'The credential lives in ' + (filing.managedBy || 'secret storage') +
      ' and cannot be viewed or changed here: a client secret stored where a web form can read it ' +
      'back is a credential worth stealing.'));

    var sync = cred.sync || {};
    if (sync.affects) {
      var note = el('p', 'hint', 'Separately: ' + sync.affects);
      note.style.marginTop = '8px';
      banner.appendChild(note);
    }

    var last = data.lastSync || {};
    var status = $('#sp-status');
    status.textContent = '';
    status.className = '';

    var headline = last.sharePointChunks
      ? last.collateralDocuments + ' document(s) indexed from SharePoint'
      : 'No SharePoint material in this build';
    status.appendChild(el('div', 'item-title', headline));

    var parts = [];
    if (last.syncedAt) parts.push('synced ' + fmtDate(last.syncedAt));
    parts.push(last.totalChunks + ' chunks total');
    if (last.sharePointChunks) parts.push(last.sharePointChunks + ' from SharePoint');
    status.appendChild(el('div', 'item-meta', parts.join(' · ')));

    if (!last.sharePointChunks) {
      status.appendChild(el('div', 'item-body',
        'The assistant is answering from the public site pages and the curated FAQ only. ' +
        'If that is unexpected, check the most recent "Sync knowledge base" workflow run.'));
    }
  }
  // --- Users ---------------------------------------------------------------

  var ROLE_LABEL = { admin: 'Admin', rep: 'Rep', denied: 'Denied' };

  /**
   * Grants this browser has made that the server list has not caught up with.
   *
   * Workers KV is eventually consistent for LIST specifically: a put is
   * visible to a get straight away, but the key can take a while to appear in
   * a list. So the panel saved a grant, re-listed, got the old answer, and
   * showed "No explicit grants yet." — the write had worked and the screen
   * said otherwise. Nothing in the test suite caught it because fakeKV is a
   * Map and answers a list immediately.
   *
   * email -> row, or null for a removal awaiting the same catch-up.
   */
  var pendingUsers = {};

  /**
   * The server's list, with this browser's own recent changes applied.
   *
   * An entry drops out of the overlay as soon as the server agrees with it,
   * so this converges rather than accumulating a parallel truth.
   */
  function mergeUsers(users) {
    var byEmail = {};
    (users || []).forEach(function (u) { byEmail[u.email] = u; });

    Object.keys(pendingUsers).forEach(function (email) {
      var mine = pendingUsers[email];
      var theirs = byEmail[email];

      if (mine === null) {
        if (theirs) delete byEmail[email];
        else delete pendingUsers[email];
        return;
      }

      if (theirs && theirs.role === mine.role) {
        delete pendingUsers[email];
        return;
      }

      byEmail[email] = Object.assign({}, mine, { pending: true });
    });

    return Object.keys(byEmail)
      .map(function (email) { return byEmail[email]; })
      .sort(function (a, b) {
        // Bootstrap admins first, as the server orders them, then by address.
        var rank = (a.source === 'bootstrap' ? 0 : 1) - (b.source === 'bootstrap' ? 0 : 1);
        return rank || a.email.localeCompare(b.email);
      });
  }

  /** Apply a change locally and repaint, before asking the server again. */
  function noteUserChange(email, row) {
    pendingUsers[String(email).toLowerCase()] = row;
    if (lastUserData) renderUsers(lastUserData);
    loadUsers();
  }

  var lastUserData = null;

  function renderUsers(data) {
    lastUserData = data;

    var list = $('#user-list');
    list.textContent = '';

    $('#user-default').textContent =
      data.defaultRole === 'rep'
        ? 'Anyone who can sign in with a Vikat account is a Rep by default. Set someone to Denied to block them.'
        : 'Nobody has access until they are granted a role here.';

    var users = mergeUsers(data.users);
    if (users.length === 0) {
      list.appendChild(el('div', 'empty', 'No explicit grants yet.'));
      return;
    }

    users.forEach(function (u) {
      var row = el('div', 'item');

      var main = el('div', 'item-main');
      var title = el('div', 'item-title');
      title.appendChild(document.createTextNode(u.email + ' '));
      title.appendChild(el('span', 'pill pill-' + u.role, ROLE_LABEL[u.role] || u.role));
      if (!u.editable) title.appendChild(document.createTextNode(' '));
      if (!u.editable) title.appendChild(el('span', 'pill pill-locked', 'From config'));
      main.appendChild(title);

      main.appendChild(el('div', 'item-meta',
        !u.editable
          ? 'Set in wrangler.toml as a bootstrap admin. Cannot be changed here.'
          : u.pending
            ? 'Saved just now — the directory takes a moment to list it.'
            : 'Granted by ' + (u.grantedBy || 'unknown') + ' · ' + fmtDate(u.updatedAt)));

      var actions = el('div', 'item-actions');

      if (u.editable) {
        var change = el('select', null);
        ['admin', 'rep', 'denied'].forEach(function (r) {
          var opt = el('option', null, ROLE_LABEL[r]);
          opt.value = r;
          if (r === u.role) opt.selected = true;
          change.appendChild(opt);
        });
        change.setAttribute('aria-label', 'Role for ' + u.email);
        change.style.width = 'auto';
        change.addEventListener('change', function () {
          api('/admin/users', { method: 'POST', body: { email: u.email, role: change.value } })
            .then(function (r) {
              toast('Role updated.');
              noteUserChange(u.email, r.user);
            })
            .catch(function () { loadUsers(); });
        });
        actions.appendChild(change);

        var del = el('button', 'danger', 'Remove');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!confirm('Remove the explicit grant for ' + u.email + '?')) return;
          api('/admin/users?email=' + encodeURIComponent(u.email), { method: 'DELETE' })
            .then(function (r) {
              toast(r.note || 'Removed.');
              noteUserChange(u.email, null);
            })
            .catch(function () {});
        });
        actions.appendChild(del);
      }

      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  $('#user-form').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/admin/users', {
      method: 'POST',
      body: { email: $('#user-email').value, role: $('#user-role').value },
    })
      .then(function (r) {
        toast('Role saved.');
        var email = $('#user-email').value;
        $('#user-form').reset();
        noteUserChange(r.user ? r.user.email : email, r.user);
      })
      .catch(function () {});
  });

  function loadUsers() {
    return api('/admin/users').then(renderUsers).catch(function () {});
  }

  // --- Boot ----------------------------------------------------------------

  function boot() {
    var initial = TABS.indexOf(location.hash.slice(1)) !== -1 ? location.hash.slice(1) : 'knowledge';
    selectTab(initial);

    api('/admin/summary')
      .then(function (s) {
        var w = $('#whoami');
        w.textContent = '';
        w.appendChild(el('b', null, s.you.email));
        w.appendChild(document.createTextNode(s.you.role + (s.you.roleSource === 'bootstrap' ? ' · from config' : '')));

        // Independent, and kept that way: a throw in one used to take the
        // rest of the sequence with it.
        [loadKnowledge, loadPositioning, loadUploadTargets, loadSharePoint, loadUsers].forEach(function (load) {
          try {
            load();
          } catch (err) {
            console.error('[admin] ' + load.name + ' failed:', err);
          }
        });
      })
      .catch(function (err) {
        // api() has already surfaced 401/403 appropriately, so an auth failure
        // needs nothing here. A ReferenceError does: this catch once swallowed
        // one thrown by the second of three loaders, so the page rendered its
        // header, loaded one tab, and left the other two on their placeholders
        // forever — with a clean console and no failed request to find.
        if (err instanceof TypeError || err instanceof ReferenceError) {
          console.error('[admin] boot failed:', err);
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
