// 修复WebSocket连接 - 添加API token支持
const fs = require('fs');
const path = 'P:\\自动脚本\\区块链\\BTC5m-Dash-main\\index.html';

let content = fs.readFileSync(path, 'utf8');

// 在connect()函数之前添加token提示逻辑
const connectCode = `
// ── WS 连接 ───────────────────────────────────────────────────
let ws = null, reconnectDelay = 1000;

async function ensureApiToken() {
  if (apiToken) return true;
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    apiToken = urlToken;
    persistApiToken();
    return true;
  }
  const saved = localStorage.getItem('btc5m_token_auto_prompted');
  if (!saved) {
    const input = prompt('请输入 APP_API_TOKEN (可在浏览器控制台运行以下命令自动生成):\\n\\n' + 
      '打开浏览器F12 Console, 粘贴以下命令后回车:\\n\\n' +
      'fetch(\\'/api/public-config\\').then(r=>r.json()).then(c=>{if(c.tokenRequired){const t=prompt(\\'输入API Token\\');if(t){localStorage.setItem(\\'btc5m_api_token\\',t);location.reload();}}});\\n\\n' +
      '或者暂时不使用token (将.env中APP_API_TOKEN设为空)');
    if (input && input.trim()) {
      apiToken = input.trim();
      persistApiToken();
      localStorage.setItem('btc5m_token_auto_prompted', '1');
      return true;
    }
    return false;
  }
  return false;
}

function connect() {
  if (!apiToken && window.location.hostname === '127.0.0.1') {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      apiToken = urlToken;
      persistApiToken();
    }
  }
  
  const wsUrl = buildWsUrl();
  const protocols = apiToken ? ['json', 'token.' + apiToken] : ['json'];
  
  ws = new WebSocket(wsUrl, protocols);
  ws.onopen = () => {
    $connDot.classList.remove('disconnected');
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'clientConfig', dataMode: lowDataMode ? 'low' : 'full' }));
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    $connDot.classList.add('disconnected');
    clearRealtimeBuffers();
    $cur.textContent = '-';
    $diff.textContent = '-'; $orderDiff.textContent = '-';
    $ptb.textContent = '-';
    curUsdc = null;
    curUpLocal = 0; curDnLocal = 0;
    curUpApi = 0; curDnApi = 0; curApiSyncAt = 0;
    clearBestDrivenState('Feed disconnected --');
    updateEst();
    updateStratUI();
    $acctUsdc.textContent = '-';
    updateCompactOverview();
    setTimeout(() => { connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  ws.onerror = () => ws.close();
}

connect();
`;

// 查找并替换旧的WS连接代码
const wsStart = content.indexOf('// ── WS 连接 ──');
const connectStart = content.indexOf('let ws = null, reconnectDelay = 1000;');
const fileEnd = content.lastIndexOf('</script>');

if (wsStart === -1 || connectStart === -1 || fileEnd === -1) {
  console.error('未找到WS连接代码');
  process.exit(1);
}

// 替换代码
const newContent = content.substring(0, wsStart) + connectCode + '\\n' + content.substring(fileEnd);

fs.writeFileSync(path, newContent, 'utf8');
console.log('✅ WebSocket连接已修复！');
console.log('💡 使用方法:');
console.log('  1. 访问 http://localhost:3000?token=pk-YOUR_TOKEN');
console.log('  2. 或在浏览器Console中运行:');
console.log('     localStorage.setItem("btc5m_api_token", "pk-YOUR_TOKEN")');
console.log('     location.reload()');
