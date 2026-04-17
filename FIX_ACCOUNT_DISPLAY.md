# 账户数据显示与买入功能修复说明

## 问题1：账户数据不显示

### 问题描述
账户数据（USDC余额、持仓等）在前端不显示。

### 根本原因

#### 1. WebSocket认证问题
- **问题**：前端通过URL参数（`?token=xxx`）传递API token，但后端的`extractToken`函数只从HTTP头中提取token
- **影响**：WebSocket连接时认证失败，导致前端无法接收任何state数据

#### 2. HTTP API认证问题  
- **问题**：同样的问题存在于HTTP API请求中
- **影响**：直接访问`/api/state`等端点会返回401未授权错误

#### 3. 前端断联时清空账户数据
- **问题**：WebSocket断联时会清空所有账户数据（`curUsdc = null`等）
- **影响**：网络不稳定时会频繁丢失账户数据显示

### 修复内容

#### 修复1：server.ts - WebSocket连接认证（第3648-3662行）

```typescript
wss.on("connection", (ws, req) => {
  // 从 URL 参数中提取 token 并添加到 headers，以便 extractToken 函数能识别
  if (req.url) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const urlToken = url.searchParams.get("token");
      if (urlToken && typeof req.headers === "object") {
        req.headers["x-api-token"] = urlToken;
      }
    } catch {
      // 忽略 URL 解析错误
    }
  }
  // ... 后续的认证逻辑
});
```

#### 修复2：server.ts - API中间件认证（第1142-1162行）

```typescript
app.use("/api", (req, res, next) => {
  // 从 URL 参数中提取 token 并添加到 headers
  if (req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const urlToken = url.searchParams.get("token");
      if (urlToken && typeof req.headers === "object") {
        req.headers["x-api-token"] = urlToken;
      }
    } catch {
      // 忽略 URL 解析错误
    }
  }
  // ... 后续的认证逻辑
});
```

#### 修复3：index.html - 断联时保留账户数据（第3076-3090行）

```javascript
ws.onclose = () => {
  $connDot.classList.add('disconnected');
  // 断联时清空实时数据，但保留账户余额显示，避免误判
  clearRealtimeBuffers();
  $cur.textContent = '-';
  $diff.textContent = '-'; $orderDiff.textContent = '-';
  $ptb.textContent = '-';
  // 不清空账户数据，保留最后已知的余额
  clearBestDrivenState('等待数据…');
  updateEst();
  updateStratUI();
  updateCompactOverview();
  // ...
};
```

---

## 问题2：买入时显示 "400 The plain HTTP request was sent to HTTPS port"

### 问题描述
点击买入按钮后，显示错误：
```
400 The plain HTTP request was sent to HTTPS port
cloudflare
```

### 根本原因

**系统环境变量设置了全局代理**：
- `HTTPS_PROXY=http://127.0.0.1:10809`
- `HTTP_PROXY=http://127.0.0.1:10809`

这些系统级代理环境变量会影响所有Node.js的HTTP/HTTPS请求，包括Polymarket ClobClient内部的请求。

当ClobClient尝试向 `https://clob.polymarket.com` 发送HTTPS请求时：
1. 请求被系统代理 `http://127.0.0.1:10809` 拦截
2. 代理将HTTPS请求错误地路由到HTTP端口
3. Cloudflare收到HTTP协议的请求但期望HTTPS，返回400错误

**注意**：即使`.env`文件中代理配置被注释掉，系统环境变量仍然会生效！

### 修复内容

#### 修复4：server.ts - 清除系统代理环境变量（第450-465行）

```typescript
const OUTBOUND_PROXY_URL = resolveOutboundProxyUrl();
const OUTBOUND_PROXY_IS_LOOPBACK = isLoopbackProxyUrl(OUTBOUND_PROXY_URL);

// 清除系统代理环境变量，避免影响 ClobClient 的 HTTPS 请求
// 系统代理会导致 "400 The plain HTTP request was sent to HTTPS port" 错误
if (!OUTBOUND_PROXY_URL) {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
}

const WS_PROXY_AGENT = OUTBOUND_PROXY_URL ? new HttpsProxyAgent(OUTBOUND_PROXY_URL) : undefined;
```

### 修复逻辑
- 如果`.env`中没有配置`APP_PROXY_URL`等代理，则清除所有系统代理环境变量
- 这样ClobClient的HTTPS请求就不会被系统代理拦截
- 如果确实需要使用代理，请在`.env`中配置`APP_PROXY_URL`

---

## 验证结果

### API测试
```powershell
# 使用URL参数token
Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/state?token=pk-xxx'

# 返回结果
{
    "usdc":  23.823439,
    "upLocalSize":  0,
    "downLocalSize":  0,
    "upApiSize":  0,
    "downApiSize":  0
}
```

### 前端显示
- ✅ USDC余额正常显示
- ✅ UP/DOWN持仓正常显示
- ✅ API同步时间正常显示
- ✅ 网络断开时保留最后已知的账户数据

### 买入功能
- ✅ 买入请求能正确发送到Polymarket API
- ✅ 不再出现 "400 The plain HTTP request was sent to HTTPS port" 错误

---

## 技术细节

### Token派生
当`APP_API_TOKEN=auto`或未设置时，系统会自动从`POLYMARKET_PRIVATE_KEY`派生token：
```
token = "pk-" + sha256("btc5m-web:app-api-token:" + privateKey)
```

### 数据同步机制
- **USDC余额**：每5秒通过`syncUsdcBalance()`同步一次
- **持仓数据**：每2秒通过`syncPositionsFromApi()`同步一次
- **状态广播**：每次同步后自动广播给所有WebSocket客户端

### 代理处理逻辑
1. 优先使用`.env`中配置的`APP_PROXY_URL`
2. 如果未配置，则清除所有系统代理环境变量
3. 避免系统代理干扰ClobClient的HTTPS请求

---

## 注意事项

1. **浏览器控制台错误**：看到的钱包扩展错误（如`Cannot redefine property: ethereum`）是正常的扩展冲突，不影响账户数据显示
2. **持仓为0**：如果账户确实没有持仓，显示0是正确的
3. **校准状态**：显示"未校准"是正常的，只有在交易后15秒内会显示"校准中"
4. **系统代理**：如果你的系统环境变量中设置了代理，本程序会自动清除它们（除非你在`.env`中明确配置了代理）

## 如何检查系统代理

在Windows命令行中运行：
```cmd
set | findstr /I "proxy"
```

如果看到`HTTPS_PROXY`或`HTTP_PROXY`，说明系统设置了全局代理。
