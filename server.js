/* =====================================================================
   恋爱日记 · 后端服务(零依赖,Node.js 18+)
   ───────────────────────────────────────────────────────────────────
   作用:补齐「账号系统」,让两个人在不同设备上登录同一账号,看到并编辑同一份内容。

   运行:
     node server.js
   然后浏览器打开 http://localhost:3000

   它做了两件事:
     1) 静态托管:直接返回 index.html / china-geo.js / uploads 里的照片。
        (前后端同源 → 免跨域;部署时也只需把这一个服务放到公网)
     2) 提供 4 个接口(前端 index.html 里的 cloud* 函数调的就是它们):
        POST /api/login    登录,发令牌
        GET  /api/site     读全站数据(公开)
        PUT  /api/site     保存全站数据(需令牌)
        POST /api/upload   上传照片(需令牌)

   账号密码读取顺序:环境变量 ADMIN_USER / ADMIN_PASS → config.json → 默认值。
   默认值(admin / change-me-123)只用于本地试玩,公网部署前务必改!

   数据文件(首次运行自动生成,请勿提交到 git):
     data.json    全站内容(回忆/标题/照片 URL)
     users.json   账号(仅存哈希,不存明文)
     uploads/     照片文件
   ===================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(ROOT, 'data.json');
const USERS_FILE = path.join(ROOT, 'users.json');

/* ---------- 配置 ---------- */
function loadConfig(){
  let cfg = {};
  try{ cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }catch(e){}
  return {
    port: +process.env.PORT || +cfg.port || 3000,
    adminUser: process.env.ADMIN_USER || cfg.adminUser || 'admin',
    adminPass: process.env.ADMIN_PASS || cfg.adminPass || 'change-me-123',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || cfg.publicBaseUrl || '',
    tokenDays: +process.env.TOKEN_DAYS || +cfg.tokenDays || 30,
  };
}
const CONFIG = loadConfig();

/* ---------- 账号(密码加盐哈希,不存明文) ---------- */
function hashPw(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt + ':' + hash.toString('hex');
}
function verifyPw(pw, stored){
  try{
    const [salt, hex] = stored.split(':');
    const a = crypto.scryptSync(pw, salt, 64);
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }catch(e){ return false; }
}
function loadUsers(){
  try{ return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }catch(e){ return []; }
}
let USERS = loadUsers();
if(!USERS.length){
  USERS = [{ user: CONFIG.adminUser, hash: hashPw(CONFIG.adminPass) }];
  fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 2));
  console.log('已创建账号:', CONFIG.adminUser);
  if(CONFIG.adminPass === 'change-me-123'){
    console.log('⚠️  正在使用默认密码 change-me-123,公网部署前务必修改 config.json(或环境变量)后重启!');
  }
}

/* ---------- 令牌(会话) ---------- */
const tokens = new Map(); // token -> { user, expires }
function issueToken(user){
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { user, expires: Date.now() + CONFIG.tokenDays * 864e5 });
  return t;
}
function authUser(req){
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if(!m) return null;
  const rec = tokens.get(m[1]);
  if(!rec) return null;
  if(rec.expires < Date.now()){ tokens.delete(m[1]); return null; }
  return rec.user;
}

/* ---------- 全站数据 ---------- */
function loadData(){
  try{ return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }catch(e){ return null; }
}
function saveData(site){
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(site));
  fs.renameSync(tmp, DATA_FILE); // 先写临时再改名,避免写到一半损坏
}

/* ---------- 工具 ---------- */
function send(res, code, obj){
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
  });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if(size > limit){ reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }catch(e){ reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
function serveFile(res, filePath){
  fs.readFile(filePath, (err, buf) => {
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-cache' });
    res.end(buf);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  let p;
  try{ p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch(e){ return res.writeHead(400), res.end('bad url'); }

  // CORS 预检
  if(req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization',
      'Access-Control-Max-Age':'86400',
    });
    return res.end();
  }

  try{
    /* ---- API ---- */
    if(p === '/api/login' && req.method === 'POST'){
      const b = await readBody(req, 1e6);
      const u = USERS.find(x => x.user === String(b && b.user || '').trim());
      if(!u || !verifyPw(String(b && b.pass || ''), u.hash)) return send(res, 401, { error:'账号或密码不对' });
      return send(res, 200, { token: issueToken(u.user) });
    }
    if(p === '/api/register' && req.method === 'POST'){
      const b = await readBody(req, 1e6);
      const user = String(b && b.user || '').trim();
      const pass = String(b && b.pass || '');
      if(!user) return send(res, 400, { error:'缺少账号' });
      if(pass.length < 4) return send(res, 400, { error:'密码至少4位' });
      if(USERS.some(x => x.user === user)) return send(res, 409, { error:'账号已存在' });
      USERS.push({ user, hash: hashPw(pass) });
      fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 2));
      return send(res, 200, { token: issueToken(user) });
    }
    if(p === '/api/site' && req.method === 'GET'){
      return send(res, 200, { data: loadData() || {} });
    }
    if(p === '/api/site' && req.method === 'PUT'){
      if(!authUser(req)) return send(res, 401, { error:'未登录或令牌过期' });
      const b = await readBody(req, 20e6);
      if(!b || typeof b.data === 'undefined') return send(res, 400, { error:'缺少 data 字段' });
      saveData(b.data);
      return send(res, 200, { ok:true, savedAt: new Date().toISOString() });
    }
    if(p === '/api/upload' && req.method === 'POST'){
      if(!authUser(req)) return send(res, 401, { error:'未登录或令牌过期' });
      const b = await readBody(req, 20e6);
      if(!b || !b.data) return send(res, 400, { error:'缺少图片数据' });
      const t = String(b.type || '');
      const ext = t.includes('png') ? 'png' : t.includes('gif') ? 'gif' : t.includes('webp') ? 'webp' : 'jpg';
      const name = 'p' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      fs.mkdirSync(UPLOAD_DIR, { recursive:true });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(b.data, 'base64'));
      return send(res, 200, { url: CONFIG.publicBaseUrl + '/uploads/' + name });
    }
    if(p === '/api/health') return send(res, 200, { ok:true, user: authUser(req) || null });

    /* ---- 静态文件 ---- */
    let fp;
    if(p === '/') fp = path.join(ROOT, 'index.html');
    else if(p.startsWith('/uploads/')) fp = path.join(UPLOAD_DIR, path.basename(p)); // basename 防目录穿越
    else fp = path.normalize(path.join(ROOT, p.slice(1)));
    if(fp !== ROOT && !fp.startsWith(ROOT + path.sep)){ res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, fp);
  }catch(e){
    console.error('处理请求出错:', e.message);
    send(res, 500, { error: e.message });
  }
});

server.listen(CONFIG.port, () => {
  console.log('────────────────────────────────────────────');
  console.log('  💐 恋爱日记后端已启动');
  console.log('  本机访问: http://localhost:' + CONFIG.port);
  console.log('  登录账号:', CONFIG.adminUser);
  if(CONFIG.adminPass === 'change-me-123') console.log('  ⚠️  仍是默认密码,记得改!');
  console.log('────────────────────────────────────────────');
});
