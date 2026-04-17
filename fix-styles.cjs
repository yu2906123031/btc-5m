// 修复index.html样式 - 转换为白色主题
const fs = require('fs');
const path = 'P:\\自动脚本\\区块链\\BTC5m-Dash-main\\index.html';

let content = fs.readFileSync(path, 'utf8');

// 查找<style>和</style>标签的位置
const styleStart = content.indexOf('<style>');
const styleEnd = content.indexOf('</style>') + '</style>'.length;

if (styleStart === -1 || styleEnd === -1) {
  console.error('未找到<style>标签');
  process.exit(1);
}

// 新的白色主题CSS
const newCSS = `<style>
/* ===== 白色主题样式 ===== */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: #f5f7fa;
  color: #2c3e50;
  line-height: 1.6;
}

/* 头部导航 */
#header {
  background: #ffffff;
  border-bottom: 1px solid #e0e6ed;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

#header .window-info {
  font-size: 14px;
  font-weight: 600;
  color: #5a6c7d;
}

#header .window-info span {
  color: #3498db;
  font-weight: 700;
}

#remaining {
  min-width: 48px;
  font-weight: 600;
}

#remaining.ending {
  color: #e74c3c !important;
  animation: pulse 0.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 最近结果 */
#recent-results {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.result-dot {
  position: relative;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #e0e6ed;
  cursor: default;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: #ffffff;
  transition: transform 0.2s;
}

.result-dot:hover {
  transform: scale(1.1);
}

.result-dot.up {
  background: #27ae60;
}

.result-dot.down {
  background: #e74c3c;
}

.result-dot .dot-tip {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 5px;
  padding: 6px 10px;
  font-size: 11px;
  color: #5a6c7d;
  white-space: nowrap;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.result-dot:hover .dot-tip {
  display: block;
}

/* 连接状态 */
#conn-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #27ae60;
  box-shadow: 0 0 6px #27ae60;
  transition: background 0.3s;
}

#conn-dot.disconnected {
  background: #e74c3c;
  box-shadow: 0 0 6px #e74c3c;
}

/* WebSocket状态 */
#ws-status {
  display: flex;
  gap: 8px;
  align-items: center;
}

.ws-light {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #7f8c8d;
}

.ws-light .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e74c3c;
  box-shadow: 0 0 4px #e74c3c;
  transition: background 0.3s, box-shadow 0.3s;
}

.ws-light.on .dot {
  background: #27ae60;
  box-shadow: 0 0 4px #27ae60;
}

/* 模式切换 */
.mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 8px;
  padding: 4px 10px;
  border: 1px solid #e0e6ed;
  border-radius: 999px;
  background: #f5f7fa;
}

.mode-toggle-label {
  font-size: 11px;
  color: #7f8c8d;
  white-space: nowrap;
}

.mode-toggle-btn {
  width: 42px;
  height: 22px;
  border: 1px solid #d0d7de;
  border-radius: 999px;
  background: #e0e6ed;
  position: relative;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.mode-toggle-btn::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  transition: transform 0.2s ease;
}

.mode-toggle-btn.on {
  background: #e8f5e9;
  border-color: #27ae60;
}

.mode-toggle-btn.on::after {
  transform: translateX(20px);
  background: #27ae60;
}

/* 价格栏 */
#price-bar {
  background: #ffffff;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 28px;
  border-bottom: 1px solid #e0e6ed;
}

#price-bar #signal-box {
  margin-left: auto;
  min-width: 220px;
  min-height: 44px;
  padding: 8px 14px;
}

.price-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.price-label {
  font-size: 10px;
  color: #7f8c8d;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.price-val {
  font-size: 20px;
  font-weight: 700;
  color: #2c3e50;
}

#btc-diff {
  font-size: 18px;
  font-weight: 700;
}

/* 信号框 */
.sig-info-icon {
  position: relative;
  display: inline-block;
  color: #95a5a6;
  font-size: 11px;
  cursor: default;
  margin-left: 4px;
  vertical-align: middle;
}

.sig-tooltip {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 6px;
  padding: 10px 12px;
  white-space: nowrap;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.sig-info-icon:hover .sig-tooltip {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sig-cfg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #5a6c7d;
}

.sig-cfg-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
}

.sig-cfg-tag.finale {
  background: #fff3e0;
  color: #f39c12;
}

.sig-cfg-tag.open {
  background: #e3f2fd;
  color: #3498db;
}

/* 紧凑概览 */
#compact-overview {
  display: none;
  padding: 16px 24px 0;
}

.compact-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.compact-card {
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
  transition: box-shadow 0.2s;
}

.compact-card:hover {
  box-shadow: 0 4px 8px rgba(0,0,0,0.1);
}

.compact-label {
  font-size: 10px;
  color: #7f8c8d;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.compact-main {
  font-size: 18px;
  font-weight: 700;
  color: #2c3e50;
}

.compact-sub {
  font-size: 11px;
  color: #95a5a6;
  line-height: 1.5;
}

/* 账户区块 */
#account-block {
  background: #ffffff;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid #e0e6ed;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.acct-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.acct-label {
  font-size: 12px;
  color: #7f8c8d;
  font-weight: 600;
}

.acct-val {
  font-size: 15px;
  font-weight: 600;
  color: #2c3e50;
}

.acct-sub {
  font-size: 11px;
  color: #95a5a6;
}

#sync-time {
  font-size: 11px;
  color: #95a5a6;
  text-align: right;
}

#calib-countdown {
  margin-left: 8px;
  color: #f39c12;
  font-weight: 600;
}

.verified-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #fff3e0;
  color: #95a5a6;
}

.verified-tag.ok {
  background: #e8f5e9;
  color: #27ae60;
}

.allowance-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.allowance-status {
  font-size: 12px;
  font-weight: 600;
  cursor: default;
}

.allowance-wrap:hover .allowance-tooltip {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.allowance-tooltip {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 6px;
  padding: 10px 12px;
  white-space: nowrap;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.allowance-tooltip div {
  font-size: 11px;
  color: #5a6c7d;
}

/* 主容器 */
#main-wrap {
  display: flex;
  gap: 0;
  flex: 1;
  padding: 20px 24px;
}

/* 低数据模式 */
body.low-data-mode {
  background: #f5f7fa;
}

body.low-data-mode #vol-box,
body.low-data-mode #main-wrap,
body.low-data-mode #compact-overview {
  display: none;
}

body.low-data-mode #header,
body.low-data-mode #price-bar,
body.low-data-mode #strat-bar,
body.low-data-mode #signal-history {
  width: min(920px, calc(100% - 24px));
  margin-left: auto;
  margin-right: auto;
}

body.low-data-mode #header {
  background: transparent;
  border: none;
  padding: 14px 4px 4px;
  gap: 14px;
}

body.low-data-mode #header .window-info {
  font-size: 13px;
  color: #7f8c8d;
}

body.low-data-mode #header .window-info span {
  color: #3498db;
}

body.low-data-mode .result-dot {
  width: 22px;
  height: 22px;
  font-size: 10px;
}

body.low-data-mode #price-bar {
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  margin-top: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

body.low-data-mode #price-bar #signal-box {
  display: none;
}

body.low-data-mode #strat-bar {
  margin-top: 8px;
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 14px;
  padding: 12px 16px;
  gap: 8px 14px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

body.low-data-mode #signal-history {
  margin-top: 8px;
  margin-bottom: 14px;
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 14px;
  padding: 10px 14px 14px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

/* 策略栏 */
#strat-bar {
  background: #ffffff;
  padding: 12px 24px;
  border-bottom: 1px solid #e0e6ed;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

#strat-bar .strat-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

#strat-bar .strat-right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

#strat-bar #strat-state-text {
  font-size: 14px;
  font-weight: 600;
  color: #5a6c7d;
}

#strat-bar #strat-scan-info {
  font-size: 12px;
  color: #7f8c8d;
}

#strat-state-text.idle { color: #95a5a6; }
#strat-state-text.scan { color: #3498db; }
#strat-state-text.active { color: #f39c12; }
#strat-state-text.hold { color: #e67e22; }
#strat-state-text.done { color: #27ae60; }

/* 策略组 */
#strat-groups {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.strat-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.strat-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #5a6c7d;
}

.strat-group input[type="checkbox"] {
  cursor: pointer;
}

.strat-amt {
  width: 60px;
  padding: 4px 8px;
  border: 1px solid #e0e6ed;
  border-radius: 4px;
  font-size: 12px;
  text-align: center;
}

/* 信号历史 */
#signal-history {
  background: #ffffff;
  border-radius: 10px;
  padding: 14px;
  border: 1px solid #e0e6ed;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

#signal-history h3 {
  font-size: 14px;
  font-weight: 600;
  color: #5a6c7d;
  margin-bottom: 10px;
}

#signal-history-list {
  max-height: 200px;
  overflow-y: auto;
}

.hist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f2f5;
  font-size: 12px;
}

.hist-item:last-child {
  border-bottom: none;
}

.hist-time {
  color: #95a5a6;
  font-family: monospace;
}

.hist-direction {
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
}

.hist-direction.up {
  background: #e8f5e9;
  color: #27ae60;
}

.hist-direction.down {
  background: #ffebee;
  color: #e74c3c;
}

.hist-result {
  font-weight: 600;
}

.hist-result.win {
  color: #27ae60;
}

.hist-result.loss {
  color: #e74c3c;
}

/* 声明区块 */
#claim-bar {
  background: #ffffff;
  padding: 12px 24px;
  border-radius: 10px;
  border: 1px solid #e0e6ed;
  display: flex;
  align-items: center;
  gap: 16px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

#claim-status {
  font-size: 12px;
  color: #5a6c7d;
}

/* 订单簿 */
#order-book {
  background: #ffffff;
  border-radius: 10px;
  padding: 14px;
  border: 1px solid #e0e6ed;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

#order-book h3 {
  font-size: 14px;
  font-weight: 600;
  color: #5a6c7d;
  margin-bottom: 10px;
}

.order-row {
  display: flex;
  align-items: center;
  padding: 4px 0;
  font-size: 12px;
  font-family: monospace;
}

.order-row.bid {
  color: #27ae60;
}

.order-row.ask {
  color: #e74c3c;
}

.depth-bar {
  height: 16px;
  background: rgba(52, 152, 219, 0.2);
  border-radius: 2px;
  margin-right: 8px;
}

/* 图表容器 */
#chart-container {
  background: #ffffff;
  border-radius: 10px;
  padding: 14px;
  border: 1px solid #e0e6ed;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
  margin-top: 16px;
}

/* 低数据英雄区 */
#low-data-hero {
  display: none;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #ffffff;
  padding: 20px 24px;
  border-radius: 14px;
  margin: 16px 0;
  text-align: center;
}

#low-data-hero .ldh-timer {
  font-size: 24px;
  font-weight: 700;
}

#low-data-hero .ldh-label {
  font-size: 12px;
  opacity: 0.9;
}

#low-data-detail {
  display: none;
  background: #ffffff;
  border: 1px solid #e0e6ed;
  border-radius: 14px;
  padding: 12px 16px;
  margin: 8px 0;
  gap: 12px;
}

/* 页脚 */
#app-footer {
  text-align: center;
  padding: 12px 0;
  font-size: 11px;
  color: #95a5a6;
  border-top: 1px solid #e0e6ed;
  margin-top: 20px;
}

/* 响应式设计 */
@media (max-width: 768px) {
  #header, #price-bar, #strat-bar {
    padding: 10px 16px;
  }
  
  #main-wrap {
    padding: 16px;
  }
  
  .compact-grid {
    grid-template-columns: 1fr;
  }
  
  #strat-groups {
    flex-direction: column;
  }
}

/* 滚动条美化 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: #f0f2f5;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb {
  background: #bdc3c7;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: #95a5a6;
}

/* 工具提示 */
[title] {
  cursor: help;
}

/* 输入框 */
input[type="number"],
input[type="text"] {
  border: 1px solid #e0e6ed;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  transition: border-color 0.2s;
}

input[type="number"]:focus,
input[type="text"]:focus {
  outline: none;
  border-color: #3498db;
  box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.1);
}

/* 按钮 */
button {
  background: #3498db;
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #2980b9;
}

button:active {
  transform: scale(0.98);
}
</style>`;

// 替换style部分
const newContent = content.substring(0, styleStart) + newCSS + content.substring(styleEnd);

fs.writeFileSync(path, newContent, 'utf8');
console.log('✅ 样式已成功更新为白色主题！');
console.log('📊 主要改进:');
console.log('  - 背景色: #f5f7fa (浅灰)');
console.log('  - 卡片: #ffffff (白色) + 阴影');
console.log('  - 主色: #3498db (蓝色)');
console.log('  - 成功: #27ae60 (绿色)');
console.log('  - 错误: #e74c3c (红色)');
console.log('  - 优化排版和响应式设计');
