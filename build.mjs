/*
 * build.mjs — 把 index.html / src/style.css / lib 本地库 内联为单个可分发 HTML。
 * 产物：函数作图器.html（离线可用，可单独拷贝分享）
 * 运行：node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

function esc(s) {
  // 内联进 <script> 时防止 "</script" 提前结束标签，并去掉缺失的 sourcemap 引用
  return s
    .replace(/<\/script/gi, '<\\/script')
    .replace(/^[ \t]*\/\/# sourceMappingURL=.*$/gm, '');
}

let html = readFileSync('index.html', 'utf8');
const before = html.length;

html = html.replace('<link rel="stylesheet" href="src/style.css">', function () {
  return '<style>\n' + readFileSync('src/style.css', 'utf8') + '\n</style>';
});

html = html.replace(/<script src="([^"]+)"><\/script>/g, function (m, p) {
  return '<script>\n' + esc(readFileSync(p, 'utf8')) + '\n</script>';
});

// 构建校验
// 说明：math.min.js 自身字符串里含有一处 "<script>"（非独立成行），
// 因此用 "<script>" 后紧跟换行 的形式统计真实内联脚本数量。
if (html.includes('src="lib/')) throw new Error('仍有未内联的本地脚本引用');
if (html.includes('href="src/')) throw new Error('仍有未内联的样式引用');
const n = (html.match(/<script>\n/g) || []).length;
if (n !== 5) throw new Error('内联脚本数量异常：' + n);
const tail = html.slice(-40);
if (tail.indexOf('</html>') === -1) throw new Error('HTML 结尾异常');

writeFileSync('函数作图器.html', html);
console.log('构建完成：函数作图器.html（' + html.length + ' 字节；源 ' + before + ' 字节）');
