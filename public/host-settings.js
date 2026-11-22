(function () {
  'use strict';

  function element(tag, parent, text, className) {
    var item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    parent.appendChild(item);
    return item;
  }

  async function request(body) {
    var response = await fetch('/api/host', {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    var value = await response.json().catch(function () { return null; });
    if (!response.ok || !value) {
      var message = response.status === 401 || response.status === 403 ? 'Sign in again on this machine to read host settings.' : 'Host settings are temporarily unavailable.';
      throw Object.assign(Error(value?.error || message), { status: response.status });
    }
    return value;
  }

  function mount(pane, dialog) {
    var sources = [], sourceNames = new Map(), roots = [], trail = [], revision = '', connected = false;
    var dirty = false, busy = false, lastURL = '', role = 'server';
    var status = element('p', pane, 'Connecting to the machine running VidStream…', 'host-status');
    status.setAttribute('role', 'status');
    var address = element('p', pane, undefined, 'host-address');
    address.hidden = true;
    var form = element('fieldset', pane, undefined, 'host-editor');
    var folders = card('Top-level media folders');
    element('p', folders, 'Choose folders on the machine running Docker. The first one opens by default.');
    var list = element('ol', folders, undefined, 'host-source-list');
    var add = element('div', folders, undefined, 'host-actions');
    var pathInput = element('input', add);
    pathInput.placeholder = 'Absolute path on the host';
    pathInput.setAttribute('aria-label', 'New media folder on the host');
    var addPath = button(add, 'Add path', function () { selectSource(pathInput.value); });
    var pick = button(add, 'Browse host…', async function () {
      if (!browser.hidden) { browser.hidden = true; return; }
      browser.hidden = false;
      showRoots();
    });
    var browser = element('div', folders, undefined, 'host-browser');
    browser.hidden = true;
    browser.setAttribute('aria-label', 'Host folder browser');
    var resources = card('Memory and network');
    var fields = element('div', resources, undefined, 'host-fields');
    var memory = field(fields, 'Maximum RAM (GiB)', 'number', '2');
    var swap = field(fields, 'Additional swap (GiB)', 'number', '0');
    memory.min = '1'; swap.min = '0'; memory.max = swap.max = '99999';
    var access = element('select', element('label', fields, 'Network access'));
    [['local', 'This machine only'], ['lan', 'Local network'], ['specific', 'Specific IPv4 address']].forEach(function (entry) {
      access.add(new Option(entry[1], entry[0]));
    });
    var bind = field(fields, 'Listen address', 'text', '127.0.0.1');
    var host = field(fields, 'Hostname or IP for viewers', 'text', '127.0.0.1');
    var port = field(fields, 'HTTP port', 'number', '80');
    port.min = '1'; port.max = '65535';
    element('p', resources, 'Port 80 opens at the hostname alone. Ports such as 8080 need a port in the address. HTTPS requires a TLS proxy.');
    var actions = element('div', resources, undefined, 'host-actions');
    var save = button(actions, 'Save to compose.yaml', async function () {
      var result = await command('save', Object.assign({ revision: revision }, configuration()));
      revision = result.revision;
      if (result.folders) setSources(result);
      showAddress(result.url);
      dirty = false;
      note('Saved to this host’s compose.yaml. Choose Apply and restart to use these settings.' + addressHint());
    });
    var template = element('details', resources);
    element('summary', template, 'Prepare a setup file for another machine');
    var setup = element('div', template, undefined, 'host-fields');
    var templateRole = element('select', element('label', setup, 'Machine role'));
    templateRole.add(new Option('Server', 'server'));
    templateRole.add(new Option('Node · one folder', 'node'));
    var theme = element('select', element('label', setup, 'Default theme'));
    [['Light', 'light-table'], ['Dark', 'darkroom'], ['Follow device', 'system']].forEach(function (entry) { theme.add(new Option(entry[0], entry[1])); });
    var destinations = element('textarea', element('label', template, 'Destination folders · one absolute path per line', 'host-field'));
    destinations.rows = 3;
    destinations.placeholder = 'Leave blank to use the selected folders above';
    element('p', template, 'Use the destination machine’s paths. Put the downloaded compose.yaml beside Start-Here on that machine and choose Start existing VidStream. The guided launcher can build the local image.');
    button(template, 'Download compose.yaml', exportCompose);
    var service = card('Run or move this instance');
    var layout = element('p', service);
    var runActions = element('div', service, undefined, 'host-actions');
    var restart = button(runActions, 'Apply and restart', function () {
      return lifecycle('apply', 'Restart this instance using the saved compose.yaml? Playback and scanning will pause.' + addressHint());
    });
    var resume = field(service, 'Start again after (minutes, 0 to stay stopped)', 'number', '0');
    resume.min = '0'; resume.max = '1440';
    var stop = button(service, 'Stop instance', function () {
      if (!resume.reportValidity()) return;
      var minutes = Number(resume.value);
      return lifecycle('stop', minutes ? 'Stop this instance for ' + minutes + ' minutes? Leave the host helper running for the scheduled start.' : 'Stop this instance? To start it again, open Start-Here on the host.', { resumeMinutes: minutes });
    });
    var migrate = button(service, 'Prepare to move…', function () {
      return lifecycle('migrate', 'Stop this instance and prepare its storage for copying? Check .vidstream-host-actions.log in the installation folder for completion before moving compose.yaml and vidstream-local. Copy or remap your source media separately.');
    });
    element('p', service, 'For a move, keep compose.yaml and vidstream-local together. After the webapp stops, check .vidstream-host-actions.log beside compose.yaml for completion before copying. On the destination, remap the source folders and start VidStream with Start-Here.');
    var refresh = button(pane, 'Read host settings again', async function () {
      if (!dirty || window.confirm('Discard the unsaved changes in this form and reload the host settings?')) await load();
    });
    access.onchange = function () {
      if (access.value === 'local') host.value = '127.0.0.1';
      else if (host.value === '127.0.0.1') host.value = ['localhost', '127.0.0.1'].includes(location.hostname) ? '' : location.hostname;
      if (access.value === 'lan') bind.value = '0.0.0.0';
      networkFields();
    };
    function networkFields() {
      bind.parentElement.hidden = access.value !== 'specific';
      host.readOnly = access.value === 'local';
    }
    resources.addEventListener('input', changed);
    resources.addEventListener('change', changed);
    pathInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addPath.click(); }
    });

    function card(title) {
      var section = element('section', form, undefined, 'settings-card');
      element('h3', section, title);
      return section;
    }
    function field(parent, title, type, initial) {
      var label = element('label', parent, title, 'host-field');
      var input = element('input', label);
      input.type = type; input.value = initial; input.required = true;
      return input;
    }
    function note(message, error) {
      status.textContent = message;
      status.classList.toggle('is-error', Boolean(error));
    }
    function available() { return pane.isConnected && dialog.open; }
    function paint() {
      form.inert = busy;
      form.setAttribute('aria-busy', String(busy));
      refresh.disabled = busy;
      save.disabled = !connected || !revision || !dirty;
      restart.disabled = stop.disabled = migrate.disabled = !connected || !revision || dirty;
      pick.disabled = !connected || !roots.length || (role === 'node' && sources.length > 0);
      addPath.disabled = role === 'node' && sources.length > 0;
    }
    function changed(event) {
      if (event && template.contains(event.target)) return;
      dirty = true; paint(); note('Unsaved settings');
    }
    function button(parent, title, action) {
      var item = element('button', parent, title, 'settings-small-button');
      item.type = 'button';
      item.onclick = async function () {
        if (busy) return;
        busy = true; paint();
        try { await action(); }
        catch (error) { if (available()) note(error.message, true); }
        finally { busy = false; paint(); }
      };
      return item;
    }
    function setSources(info) {
      sources = info.folders.map(function (folder) { return folder.path; });
      sourceNames = new Map(info.folders.map(function (folder) { return [folder.path, folder.name]; }));
      roots = info.roots || [];
      browser.hidden = true;
      drawSources();
    }
    function drawSources() {
      list.replaceChildren();
      sources.forEach(function (path, index) {
        var row = element('li', list);
        var info = element('span', row);
        element('strong', info, sourceNames.get(path) || path.split(/[\\/]/).filter(Boolean).pop() || path);
        element('small', info, (index === 0 ? 'Default · ' : '') + path);
        var order = element('div', row, undefined, 'host-row-actions');
        function move(delta) {
          var destination = index + delta;
          sources.splice(destination, 0, sources.splice(index, 1)[0]);
          changed(); drawSources();
        }
        var up = button(order, '↑', function () { move(-1); });
        var down = button(order, '↓', function () { move(1); });
        up.setAttribute('aria-label', 'Move ' + path + ' earlier');
        down.setAttribute('aria-label', 'Move ' + path + ' later');
        up.disabled = index === 0; down.disabled = index === sources.length - 1;
        var remove = button(order, 'Remove', function () { sources.splice(index, 1); changed(); drawSources(); });
        remove.setAttribute('aria-label', 'Remove mount for ' + path);
      });
    }
    function selectSource(value) {
      var path = value.trim();
      if (!path) throw Error('Choose or enter a host folder first.');
      if (sources.includes(path)) throw Error('This folder is already selected.');
      if (role === 'node' && sources.length > 0) throw Error('A node has one media folder. Remove the current mount to replace it.');
      sources.push(path); pathInput.value = ''; browser.hidden = true;
      changed(); drawSources();
    }
    function showRoots() {
      trail = []; browser.replaceChildren();
      element('strong', browser, 'Folders approved on the host');
      roots.forEach(function (root) { button(browser, root.path, function () { return browse(root.path, [], 0); }); });
      element('p', browser, 'To make another drive browsable, allow its folder in Start-Here on the host.');
    }
    async function browse(path, ancestors, offset) {
      var result = await command('browse', { path: path, offset: offset });
      if (!available()) return;
      trail = ancestors;
      if (!offset) {
        browser.replaceChildren();
        element('strong', browser, result.path);
        var row = element('div', browser, undefined, 'host-actions');
        button(row, 'Back', function () {
          if (!trail.length) return showRoots();
          return browse(trail[trail.length - 1], trail.slice(0, -1), 0);
        });
        button(row, 'Use this folder', function () { selectSource(result.path); });
      }
      browser.querySelector('.host-more')?.remove();
      (result.folders || []).forEach(function (folder) {
        button(browser, folder.name + ' ›', function () { return browse(folder.path, ancestors.concat(result.path), 0); });
      });
      if (result.nextOffset != null) {
        button(browser, 'More folders', function () { return browse(path, ancestors, result.nextOffset); }).classList.add('host-more');
      } else if (!offset && !result.folders.length) element('p', browser, 'No subfolders here.');
    }
    function configuration(paths = sources) {
      if (!paths.length) throw Error('Choose at least one top-level media folder.');
      for (var input of [memory, swap, host, port].concat(access.value === 'specific' ? [bind] : [])) {
        if (!input.reportValidity()) throw Error('Check the highlighted host setting.');
      }
      return { folders: paths.slice(), deployment: {
        memory: Number(memory.value), swap: Number(swap.value), port: Number(port.value),
        bind: access.value === 'specific' ? bind.value.trim() : access.value === 'lan' ? '0.0.0.0' : '127.0.0.1',
        host: host.value.trim()
      } };
    }
    function showAddress(value) {
      lastURL = value || '';
      address.replaceChildren();
      address.hidden = !lastURL;
      if (!lastURL) return;
      var url;
      try { url = new URL(lastURL); } catch (_) { return; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      var loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      element('span', address, loopback ? 'Saved address on the Docker host · ' : 'Saved address after restart · ');
      if (loopback && !['127.0.0.1', 'localhost'].includes(location.hostname)) {
        element('code', address, url.origin);
      } else {
        var link = element('a', address, url.origin);
        link.href = url.origin;
      }
    }
    function addressHint() { return lastURL ? ' Saved address: ' + lastURL + '.' : ''; }
    async function exportCompose() {
      var paths = destinations.value.trim() ? destinations.value.split(/\r?\n/).map(function (path) { return path.trim(); }).filter(Boolean) : sources;
      var body = Object.assign(configuration(paths), { role: templateRole.value, theme: theme.value });
      var response = await fetch('/api/host/compose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!response.ok) throw Error((await response.json()).error || 'Could not export Compose.');
      var url = URL.createObjectURL(await response.blob());
      var link = element('a', pane);
      link.href = url; link.download = 'compose.yaml'; link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      note('Downloaded a new setup template using the folders and limits shown here.');
    }
    async function waitFor(id, action) {
      var lifecycleAction = ['apply', 'stop', 'migrate'].includes(action);
      var started = Date.now(), reconnecting = false;
      while (available()) {
        await new Promise(function (resolve) { setTimeout(resolve, reconnecting ? 2500 : 800); });
        if (!available()) break;
        var result;
        try { result = await request(); }
        catch (error) {
          if (!lifecycleAction || error.status === 401 || error.status === 403) throw error;
          connected = false;
          if (action === 'apply' && Date.now() - started < 120000) {
            reconnecting = true;
            note('Restart requested. Waiting for the app at this address…' + addressHint());
            continue;
          }
          if (action === 'migrate') {
            note('The webapp is offline. Before copying, find READY TO COPY for job ' + id + ' in .vidstream-host-actions.log beside compose.yaml.');
          } else if (action === 'stop') {
            note('The host accepted the stop request. Check .vidstream-host-actions.log for job ' + id + ' to confirm shutdown.');
          } else {
            note('The host accepted the restart request. Open the saved address to reconnect.' + addressHint());
          }
          return {};
        }
        if (!available()) break;
        connected = Boolean(result.connected && result.managed);
        var job = result.job;
        if (!job || job.id !== id) throw Error('The host job changed. Read the current host settings before trying again.');
        if (job.state === 'failed') throw Error(job.message || 'Host request failed.');
        if (job.state === 'done') { note(job.message || 'Host request finished.'); return job.result || {}; }
        if (!result.connected || Date.now() - started > (lifecycleAction ? 30 * 60 : 2 * 60) * 1000) {
          throw Error('Still waiting for confirmation. Reopen Host & folders to see the latest result.');
        }
        note((job.message || 'Waiting for the host…') + (lifecycleAction ? ' Job ' + id + '.' : ''));
      }
      throw Error('Host panel closed.');
    }
    async function command(action, data) {
      var started = await request(Object.assign({ action: action }, data));
      if (action === 'migrate') note('Migration accepted. Match job ' + started.id + ' in .vidstream-host-actions.log before copying.');
      return waitFor(started.id, action);
    }
    async function lifecycle(action, confirmation, data) {
      if (window.confirm(confirmation)) {
        note('Sending request to the host…');
        await command(action, data);
      }
    }
    async function load() {
      var state = await request();
      connected = Boolean(state.connected && state.managed);
      var previous = state.job;
      if (!connected) {
        revision = ''; roots = [];
        note(state.managed ? 'To enable live controls, choose Start existing VidStream in Start-Here on this host.' : 'Manual installation. You can download a setup template here. Start-Here connects the host controls.');
        paint(); return;
      }
      if (previous && ['running', 'queued'].includes(previous.state)) {
        await waitFor(previous.id, previous.action);
        if (!connected || !available()) return;
      }
      var info = await command('inspect');
      if (!available()) return;
      revision = info.revision; role = info.role || 'server'; templateRole.value = role;
      setSources(info);
      var settings = info.deployment;
      showAddress(settings.url);
      memory.value = settings.memory; swap.value = settings.swap;
      bind.value = settings.bind; host.value = settings.host; port.value = settings.port;
      access.value = settings.bind === '127.0.0.1' ? 'local' : settings.bind === '0.0.0.0' ? 'lan' : 'specific';
      layout.textContent = info.storage === 'legacy' ? 'This installation uses Docker volumes. Preparing a move copies them to portable storage and retains the old volumes.' : 'Portable storage uses the vidstream-local folder alongside compose.yaml.';
      dirty = false;
      networkFields(); paint();
      if (previous?.state === 'failed') note(previous.message || 'The previous host operation failed.', true);
      else note('Connected to the host. Media mounts are read-only.' + addressHint());
    }
    dialog.addEventListener('stream:node-role', function (event) {
      role = event.detail;
      paint();
    });
    networkFields(); paint(); refresh.click();
  }

  window.StreamHostSettings = { mount: mount };
})();
