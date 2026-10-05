/* =====================================================================
   恋爱日记 · Cloudflare Worker(免费后端)
   ───────────────────────────────────────────────────────────────────
   配合 GitHub Pages 上的静态站使用:前端 index.html 里的
   CLOUD.baseUrl 指向本 Worker 的 URL 即可。

   ★ 账号密码写在本文件的 accounts 对象里(明文、随公开仓库可见,仅作轻量保护):
     要加账号 / 改密码 → 直接改 accounts,再 wrangler deploy 即可。
   ★ 数据存 KV:建一个 KV 命名空间,并绑定为本 Worker 的变量 STORE。

   接口(与 index.html 里的 cloud* 函数一一对应):
     POST /api/login    body {user, pass}        → {token}
     GET  /api/site    (需 Bearer token)          → {data}
     PUT  /api/site     body {data}              → {ok}   (需 Bearer token)
     POST /api/upload   body {name, type, data}  → {url}  (需 Bearer token)
     GET  /photo/:id    返回图片
     GET  /api/health   检查密钥/KV 是否配置好
   ===================================================================== */
const TOKEN_DAYS = 30;

/* 账号(用户名 → 密码)。明文存于公开仓库,仅作个人/朋友间的轻量保护;
   要增删账号或改密码,直接改这里再重新 wrangler deploy 即可。 */
const accounts = {
  khui: 'salt',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type':'application/json; charset=utf-8', ...CORS },
  });
}

async function auth(req, env){
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if(!m) return null;
  return (await env.STORE.get('token:' + m[1])) || null;
}

async function handle(req, env){
  const url = new URL(req.url);
  const p = url.pathname;

  if(req.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });

  /* 登录 */
  if(p === '/api/login' && req.method === 'POST'){
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    if(accounts[b.user] && accounts[b.user] === b.pass){
      const token = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'');
      await env.STORE.put('token:' + token, b.user, { expirationTtl: TOKEN_DAYS * 86400 });
      return json({ token });
    }
    return json({ error:'账号或密码不对' }, 401);
  }

  /* 读全站数据(需登录) */
  if(p === '/api/site' && req.method === 'GET'){
    if(!(await auth(req, env))) return json({ error:'未登录或令牌过期' }, 401);
    const s = await env.STORE.get('site');
    let data = null;
    if(s){ try{ data = JSON.parse(s); }catch(e){ data = null; } }
    return json({ data });
  }

  /* 保存全站数据(需登录) */
  if(p === '/api/site' && req.method === 'PUT'){
    if(!(await auth(req, env))) return json({ error:'未登录或令牌过期' }, 401);
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    if(typeof b.data === 'undefined') return json({ error:'缺少 data 字段' }, 400);
    await env.STORE.put('site', JSON.stringify(b.data));
    return json({ ok:true, savedAt:new Date().toISOString() });
  }

  /* 上传照片(需登录) */
  if(p === '/api/upload' && req.method === 'POST'){
    if(!(await auth(req, env))) return json({ error:'未登录或令牌过期' }, 401);
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    if(!b || !b.data) return json({ error:'缺少图片数据' }, 400);
    const id = crypto.randomUUID().replace(/-/g,'');
    await env.STORE.put('photo:' + id, JSON.stringify({ t: b.type || 'image/jpeg', d: b.data }));
    return json({ url: url.origin + '/photo/' + id });
  }

  /* 取照片 */
  if(p.startsWith('/photo/') && req.method === 'GET'){
    const id = p.slice('/photo/'.length);
    const raw = await env.STORE.get('photo:' + id);
    if(!raw) return new Response('not found', { status:404 });
    let o; try{ o = JSON.parse(raw); }catch(e){ return new Response('数据损坏', { status:500 }); }
    const bytes = Uint8Array.from(atob(o.d), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': o.t || 'image/jpeg', 'Cache-Control':'public, max-age=31536000', ...CORS } });
  }

  /* 健康检查:确认账号表已配置 */
  if(p === '/api/health'){
    return json({ ok:true, accounts: Object.keys(accounts).length });
  }

  return json({ ok:true, hint:'love-story api', path:p });
}

export default {
  async fetch(request, env){
    try{ return await handle(request, env); }
    catch(e){ return json({ error:String(e) }, 500); }
  }
};
