const $ = (id) => document.getElementById(id);

function setConn(text, cls) {
  $('conn').textContent = text;
  $('conn').className = `pill ${cls || ''}`;
}

function drawChannel(ch, info) {
  const db = info && info.frames ? Math.max(-60, info.levelDb) : -60;
  $(`lvl-${ch}`).style.width = `${((db + 60) / 60) * 100}%`;
  $(`db-${ch}`).textContent = info && info.frames ? `${info.levelDb} dB` : '-';
}

function drawSession(s) {
  if (!s) {
    $('session').textContent = 'No session.';
    drawChannel('client', null);
    drawChannel('me', null);
    return;
  }
  const c = s.channels;
  $('session').textContent =
    `${s.id} (${s.source}) | client ${c.client.seconds}s, ${c.client.missing} missing | me ${c.me.seconds}s, ${c.me.missing} missing`;
  drawChannel('client', c.client);
  drawChannel('me', c.me);
}

let retry = 500;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = new URLSearchParams(location.search).get('token');
  const ws = new WebSocket(`${proto}//${location.host}/ws/ui${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  ws.onopen = () => { retry = 500; setConn('Connected', 'ok'); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'status':
        $('headline').textContent = msg.capturing ? 'Listening.' : 'Waiting for a meeting to start.';
        drawSession(msg.session);
        break;
      case 'levels':
        drawSession(msg.session);
        break;
      case 'session-ended':
        $('headline').textContent = `Session ended: ${msg.reason}.`;
        drawSession(null);
        $('session').textContent = `Saved as sessions/${msg.session.id}/`;
        break;
      case 'capture-disconnected':
        setConn('Connected, capture page closed', 'warn');
        break;
      case 'capture-connected':
        setConn('Connected', 'ok');
        break;
    }
  };
  ws.onclose = () => {
    setConn('Reconnecting', 'bad');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}
connect();
