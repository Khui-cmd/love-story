/* =====================================================================
   恋爱日记 · Cloudflare Worker(免费后端)
   ───────────────────────────────────────────────────────────────────
   配合 GitHub Pages 上的静态站使用:前端 index.html 里的
   CLOUD.baseUrl 指向本 Worker 的 URL 即可。

   ★ 账号存在 KV(users 键):网页里可「修改密码 / 账号管理」。
     首次部署或用户表为空时,用下面的 accounts 作种子写入 KV。
     种子里的 admin 账号是管理员,可在网页里增删账号。
     (密码明文存放,仅作个人/朋友间的轻量保护)

   接口:
     POST   /api/login       body {user, pass}                 → {token, admin}
     POST   /api/register    body {user, pass}                 → {token, admin:false} 自助建号(仅普通账号)
     GET    /api/site        (需 Bearer token)                  → {data}    按账号隔离
     PUT    /api/site        (需 token) body {data}             → {ok}
     POST   /api/upload      (需 token) body {name,type,data}   → {url}
     GET    /photo/:id       返回图片
     POST   /api/password    (需 token) body {old,new}          → {ok}      改自己密码
     GET    /api/users       (需管理员)                          → {users}
     POST   /api/users       (需管理员) body {user,pass}         → {ok}      添加账号
     DELETE /api/users/:name (需管理员)                          → {ok}      删除账号
     POST   /api/users/:name/password (需管理员) body {new}      → {ok}      重置账号密码
     GET    /api/health     检查配置
   ===================================================================== */
const TOKEN_DAYS = 30;

/* 种子账号:用户表为空时写入 KV。admin 账号可管理其他账号。 */
const accounts = {
  khui: { pass: 'salt', admin: true },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type':'application/json; charset=utf-8', ...CORS },
  });
}

async function getUsers(env){
  const raw = await env.STORE.get('users');
  if(raw){ try{ const u = JSON.parse(raw); if(u && typeof u === 'object') return u; }catch(e){} }
  const seed = {};
  for(const [name, v] of Object.entries(accounts)){
    seed[name] = { pass: v.pass, admin: !!v.admin };
  }
  await env.STORE.put('users', JSON.stringify(seed));
  return seed;
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
    const users = await getUsers(env);
    const rec = users[b.user];
    if(rec && rec.pass === b.pass){
      const token = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'');
      await env.STORE.put('token:' + token, b.user, { expirationTtl: TOKEN_DAYS * 86400 });
      return json({ token, admin: !!rec.admin });
    }
    return json({ error:'账号或密码不对' }, 401);
  }

  /* 注册(自助建号,新账号一律为普通账号,管理员仍需在后台添加) */
  if(p === '/api/register' && req.method === 'POST'){
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    const name = String(b && b.user || '').trim();
    if(!name) return json({ error:'缺少账号' }, 400);
    if(String(b && b.pass || '').length < 4) return json({ error:'密码至少4位' }, 400);
    const users = await getUsers(env);
    if(users[name]) return json({ error:'账号已存在' }, 409);
    users[name] = { pass: String(b.pass), admin: false };
    await env.STORE.put('users', JSON.stringify(users));
    const token = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'');
    await env.STORE.put('token:' + token, name, { expirationTtl: TOKEN_DAYS * 86400 });
    return json({ token, admin: false });
  }

  /* 读全站数据(需登录,按账号隔离) */
  if(p === '/api/site' && req.method === 'GET'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    const s = await env.STORE.get('site:' + u);
    let data = null;
    if(s){ try{ data = JSON.parse(s); }catch(e){ data = null; } }
    return json({ data });
  }

  /* 保存全站数据(需登录) */
  if(p === '/api/site' && req.method === 'PUT'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    if(typeof b.data === 'undefined') return json({ error:'缺少 data 字段' }, 400);
    await env.STORE.put('site:' + u, JSON.stringify(b.data));
    return json({ ok:true, savedAt:new Date().toISOString() });
  }

  /* 修改自己的密码 */
  if(p === '/api/password' && req.method === 'POST'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    if(!b.new) return json({ error:'缺少新密码' }, 400);
    const users = await getUsers(env);
    const rec = users[u];
    if(!rec) return json({ error:'账号不存在' }, 404);
    if(rec.pass !== b.old) return json({ error:'旧密码不对' }, 401);
    rec.pass = b.new;
    await env.STORE.put('users', JSON.stringify(users));
    return json({ ok:true });
  }

  /* 账号列表(需管理员) */
  if(p === '/api/users' && req.method === 'GET'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    const users = await getUsers(env);
    if(!(users[u] && users[u].admin)) return json({ error:'需要管理员权限' }, 403);
    return json({ users: Object.keys(users).map(name => ({ user:name, admin: !!users[name].admin })) });
  }

  /* 添加账号(需管理员) */
  if(p === '/api/users' && req.method === 'POST'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    const users = await getUsers(env);
    if(!(users[u] && users[u].admin)) return json({ error:'需要管理员权限' }, 403);
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    if(!b.user || !b.pass) return json({ error:'缺少账号或密码' }, 400);
    if(users[b.user]) return json({ error:'账号已存在' }, 409);
    users[b.user] = { pass: b.pass, admin: false };
    await env.STORE.put('users', JSON.stringify(users));
    return json({ ok:true });
  }

  /* 删除账号(需管理员) */
  if(p.startsWith('/api/users/') && req.method === 'DELETE'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    const users = await getUsers(env);
    if(!(users[u] && users[u].admin)) return json({ error:'需要管理员权限' }, 403);
    const name = decodeURIComponent(p.slice('/api/users/'.length));
    if(!name || !users[name]) return json({ error:'账号不存在' }, 404);
    if(users[name].admin) return json({ error:'不能删除管理员账号' }, 400);
    delete users[name];
    await env.STORE.put('users', JSON.stringify(users));
    await env.STORE.delete('site:' + name); // 一并删除其回忆数据
    return json({ ok:true });
  }

  /* 重置某账号密码(需管理员) */
  if(p.startsWith('/api/users/') && p.endsWith('/password') && req.method === 'POST'){
    const u = await auth(req, env);
    if(!u) return json({ error:'未登录或令牌过期' }, 401);
    const users = await getUsers(env);
    if(!(users[u] && users[u].admin)) return json({ error:'需要管理员权限' }, 403);
    let b; try{ b = await req.json(); }catch(e){ return json({ error:'请求格式错误' }, 400); }
    const name = decodeURIComponent(p.slice('/api/users/'.length, -'/password'.length));
    if(!name || !users[name]) return json({ error:'账号不存在' }, 404);
    if(!b.new || String(b.new).length < 4) return json({ error:'新密码至少4位' }, 400);
    users[name].pass = String(b.new);
    await env.STORE.put('users', JSON.stringify(users));
    return json({ ok:true });
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

  /* 健康检查 */
  if(p === '/api/health'){
    return json({ ok:true });
  }

  return json({ ok:true, hint:'love-story api', path:p });
}

export default {
  async fetch(request, env){
    try{ return await handle(request, env); }
    catch(e){ return json({ error:String(e) }, 500); }
  }
};
