/*  GLM 本地转发代理（可选，零依赖）
 *  用途：仅当你在「设置」里选了 GLM 官方 Key，且浏览器从 file:// 直连 bigmodel.cn 被 CORS 拦截时使用。
 *  默认的 Puter 模式不需要本代理。
 *
 *  运行：  node glm-proxy.mjs        （需 Node 18+，自带 fetch）
 *  然后：  在助手「设置」中把请求端点(glmBase)改为：  http://localhost:8787/v4/chat/completions
 *          （可在控制台执行： WCAgent.setConfig({ glmBase:'http://localhost:8787/v4/chat/completions' }) ）
 *  Key 仍由前端在 Authorization 头里携带，本代理只做透传 + 补 CORS 头，不存储任何密钥。
 */
import http from 'node:http';

const PORT = 8787;
const UPSTREAM = 'https://open.bigmodel.cn/api/paas';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers['authorization'] || ''
      },
      body: req.method === 'POST' ? body : undefined
    });
    res.writeHead(upstream.status, {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    // 流式透传
    const reader = upstream.body.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
    res.end();
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '代理转发失败: ' + (e.message || e) } }));
  }
}).listen(PORT, () => console.log('GLM 代理已启动 → http://localhost:' + PORT + '  (转发到 ' + UPSTREAM + ')'));
