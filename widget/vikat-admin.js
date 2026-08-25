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
        toast('Your session expired. Reloading…', true);
        setTimeout(function () { location.reload(); }, 1500);
      } else if (res.status === 403) {
        renderForbidden();
      } else {
        toast((payload && payload.error) || ('Request failed (' + res.status + ')'), true);
      }
      throw new Error((payload && payload.error) || res.status);
    }

    return payload;
  }

  function renderForbidden() {
    document.querySelector('main').innerHTML =
      '<h1>Not available</h1>' +
      '<p class="lede">Your account does not have administrator access to the sales assistant. ' +
      'Ask an existing admin to grant it.</p>';
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

  // --- SharePoint ----------------------------------------------------------

  function renderSharePoint(data) {
    var s = data.settings || {};
    $('#sp-hostname').value = s.hostname || '';
    $('#sp-sitepath').value = s.sitePath || '';
    $('#sp-library').value = s.library || '';
    $('#sp-folder').value = s.folder || '';

    $('#sp-meta').textContent = s.updatedAt
      ? 'Last changed ' + fmtDate(s.updatedAt) + ' by ' + s.updatedBy
      : 'Never configured.';

    var cred = data.credentials || {};
    var banner = $('#sp-credentials');
    banner.textContent = '';
    banner.className = 'banner ' + (cred.configured ? 'banner-ok' : 'banner-warn');

    var strong = el('strong', null, cred.configured
      ? 'Graph credentials are configured.'
      : 'Graph credentials are not configured — the sync will not run.');
    banner.appendChild(strong);
    banner.appendChild(document.createTextNode(' They are held in ' + (cred.managedBy || 'secret storage') + ' and cannot be viewed or changed here. '));
    banner.appendChild(document.createTextNode(
      'That is deliberate: a client secret stored where a web form can read it back is a credential worth stealing, ' +
      'and the sync runs in CI rather than in this Worker, so a value typed here would never reach it.',
    ));

    var last = data.lastSync;
    var status = $('#sp-status');
    status.textContent = '';

    if (!last) {
      status.className = 'empty';
      status.textContent = 'No sync has reported yet.';
      return;
    }

    status.className = '';
    status.appendChild(el('div', 'item-title', last.ok ? 'Succeeded' : 'Failed'));
    status.appendChild(el('div', 'item-meta',
      fmtDate(last.updatedAt) + ' · ' + (last.chunks != null ? last.chunks + ' chunks' : 'no chunk count')));
    if (last.message) status.appendChild(el('div', 'item-body', last.message));
  }

  $('#sp-form').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/admin/sharepoint', {
      method: 'PUT',
      body: {
        hostname: $('#sp-hostname').value,
        sitePath: $('#sp-sitepath').value,
        library: $('#sp-library').value,
        folder: $('#sp-folder').value,
      },
    })
      .then(function (r) {
        toast(r.note || 'Saved.');
        loadSharePoint();
      })
      .catch(function () {});
  });

  function loadSharePoint() {
    return api('/admin/sharepoint').then(renderSharePoint).catch(function () {});
  }

  // --- Users ---------------------------------------------------------------

  var ROLE_LABEL = { admin: 'Admin', rep: 'Rep', denied: 'Denied' };

  function renderUsers(data) {
    var list = $('#user-list');
    list.textContent = '';

    $('#user-default').textContent =
      data.defaultRole === 'rep'
        ? 'Anyone who can sign in with a Vikat account is a Rep by default. Set someone to Denied to block them.'
        : 'Nobody has access until they are granted a role here.';

    var users = data.users || [];
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
        u.editable
          ? 'Granted by ' + (u.grantedBy || 'unknown') + ' · ' + fmtDate(u.updatedAt)
          : 'Set in wrangler.toml as a bootstrap admin. Cannot be changed here.'));

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
            .then(function () { toast('Role updated.'); loadUsers(); })
            .catch(function () { loadUsers(); });
        });
        actions.appendChild(change);

        var del = el('button', 'danger', 'Remove');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!confirm('Remove the explicit grant for ' + u.email + '?')) return;
          api('/admin/users?email=' + encodeURIComponent(u.email), { method: 'DELETE' })
            .then(function (r) { toast(r.note || 'Removed.'); loadUsers(); })
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
      .then(function () {
        toast('Role saved.');
        $('#user-form').reset();
        loadUsers();
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

        loadKnowledge();
        loadSharePoint();
        loadUsers();
      })
      .catch(function () {
        // api() has already surfaced 401/403 appropriately.
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
