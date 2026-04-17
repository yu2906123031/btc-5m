// 优化index.html样式 - 改为白色主题
const fs = require('fs');
const path = 'P:\\自动脚本\\区块链\\BTC5m-Dash-main\\index.html';

let content = fs.readFileSync(path, 'utf8');

// 颜色映射表：深色 -> 白色主题
const colorReplacements = {
  // 背景色
  '#0d1117': '#f5f7fa',
  '#161b22': '#ffffff',
  '#21262d': '#e0e6ed',
  '#1c2128': '#ffffff',
  '#11151b': '#ffffff',
  '#1a1f28': '#e0e6ed',
  '#0a0e13': '#f5f7fa',
  '#0d3b22': '#e8f5e9',
  '#0d1f33': '#e3f2fd',
  '#2a1200': '#fff3e0',
  '#1a3a1f': '#e8f5e9',
  '#2a1f00': '#fff3e0',
  
  // 文字颜色
  '#e0e0e0': '#2c3e50',
  '#888': '#7f8c8d',
  '#666': '#95a5a6',
  '#777': '#7f8c8d',
  '#aaa': '#5a6c7d',
  '#ccc': '#5a6c7d',
  '#6a7380': '#7f8c8d',
  '#8a9bb0': '#3498db',
  
  // 状态色
  '#3fb950': '#27ae60',
  '#2ea043': '#27ae60',
  '#f85149': '#e74c3c',
  '#d73a3a': '#e74c3c',
  '#f0a500': '#f39c12',
  
  // 边框色
  '#30363d': '#d0d7de',
  '#4e9eff': '#3498db',
  
  // 阴影色
  'rgba(0,0,0,0.4)': 'rgba(0,0,0,0.1)',
};

// 逐个替换颜色
for (const [oldColor, newColor] of Object.entries(colorReplacements)) {
  const oldUpper = oldColor.toUpperCase();
  const oldLower = oldColor.toLowerCase();
  content = content.split(oldUpper).join(newColor);
  content = content.split(oldLower).join(newColor);
}

// 修改body背景
content = content.replace(
  /body\s*\{[^}]*background:\s*#[0-9a-fA-F]+/,
  `body {
  background: #f5f7fa`
);

// 添加卡片阴影效果
content = content.replace(
  /(\.compact-card\s*\{[^}]*border:\s*1px solid\s*#[0-9a-fA-F]+;)/,
  `$1\n  box-shadow: 0 2px 4px rgba(0,0,0,0.05);`
);

// 修改滚动条样式
const scrollbarStyle = `
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
`;

// 在</style>前插入滚动条样式
content = content.replace('</style>', scrollbarStyle + '\n</style>');

// 写入文件
fs.writeFileSync(path, content, 'utf8');

console.log('✅ 样式已优化为白色主题！');
console.log('🎨 主要改动:');
console.log('  • 背景: #f5f7fa (浅灰)');
console.log('  • 卡片: #ffffff (白色)');
console.log('  • 主色: #3498db (蓝)');
console.log('  • 成功: #27ae60 (绿)');
console.log('  • 警告: #f39c12 (橙)');
console.log('  • 错误: #e74c3c (红)');
console.log('  • 文字: #2c3e50 (深灰)');
console.log('  • 辅助文字: #7f8c8d, #95a5a6');
console.log('  • 边框: #e0e6ed, #d0d7de');
console.log('  • 美化滚动条');
