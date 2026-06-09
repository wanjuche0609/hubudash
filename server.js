const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'hubudash_jwt_secret_2026';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'hubudash.db');
// 确保数据目录存在
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── 数据库 ───────────────────────────────────────────
let db;

function saveDb() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {}
}
setInterval(saveDb, 30000);
process.on('SIGINT', () => { saveDb(); process.exit(); });

function dbRun(sql, params = []) {
  try { db.run(sql, params); saveDb(); } catch(e) { console.error('SQL:', e.message); throw e; }
}
function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql); stmt.bind(params);
    if (stmt.step()) { const cols = stmt.getColumnNames(); const vals = stmt.get(); const obj = {}; cols.forEach((c,i) => obj[c]=vals[i]); stmt.free(); return obj; }
    stmt.free(); return undefined;
  } catch(e) { console.error('SQL:', e.message); throw e; }
}
function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql); stmt.bind(params); const results = []; const cols = stmt.getColumnNames();
    while (stmt.step()) { const vals = stmt.get(); const obj = {}; cols.forEach((c,i) => obj[c]=vals[i]); results.push(obj); }
    stmt.free(); return results;
  } catch(e) { console.error('SQL:', e.message); throw e; }
}

function initDatabase() {
  // 统一用户表（可下单也可接单）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password      TEXT NOT NULL,
    phone         TEXT NOT NULL,
    real_name     TEXT DEFAULT '',
    campus        TEXT DEFAULT '湖北大学 · 武昌校区',
    rating        REAL DEFAULT 5.0,
    wallet_balance REAL DEFAULT 0.00,
    total_orders  INTEGER DEFAULT 0,
    is_online     INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no      TEXT NOT NULL UNIQUE,
    user_id       INTEGER NOT NULL,
    rider_id      INTEGER,
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    pickup_addr   TEXT NOT NULL,
    delivery_addr TEXT NOT NULL,
    pickup_lat    REAL NOT NULL,
    pickup_lng    REAL NOT NULL,
    delivery_lat  REAL NOT NULL,
    delivery_lng  REAL NOT NULL,
    distance_km   REAL DEFAULT 0,
    details       TEXT DEFAULT '',
    phone         TEXT NOT NULL,
    base_fee      REAL DEFAULT 0,
    distance_fee  REAL DEFAULT 0,
    tip           REAL DEFAULT 0,
    deposit       REAL DEFAULT 0,
    total_fee     REAL DEFAULT 0,
    rider_fee     REAL DEFAULT 0,
    item_info     TEXT DEFAULT '{}',
    status        TEXT DEFAULT 'pending',
    rating        INTEGER DEFAULT NULL,
    rating_comment TEXT DEFAULT NULL,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    accepted_at   TEXT,
    delivered_at  TEXT,
    confirmed_at  TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL,
    rider_id    INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    amount      REAL NOT NULL,
    type        TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS campuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT DEFAULT '',
    lat REAL DEFAULT 30.5751, lng REAL DEFAULT 114.3308, sort_order INTEGER DEFAULT 0
  )`);

  db.run('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

  // 迁移：旧 riders 表数据合并到 users
  try {
    const oldRiders = dbAll('SELECT * FROM riders');
    for (const r of oldRiders) {
      const existing = dbGet('SELECT id FROM users WHERE username = ?', [r.username]);
      if (!existing) {
        dbRun('INSERT INTO users (username, password, phone, real_name, rating, wallet_balance, total_orders, is_online) VALUES (?,?,?,?,?,?,?,?)',
          [r.username, r.password, r.phone, r.real_name, r.rating, r.wallet_balance, r.total_orders, r.is_online]);
      }
    }
    db.run('DROP TABLE IF EXISTS riders');
  } catch(e) {}

  // 迁移：旧 users 表缺少的列
  try { db.run('ALTER TABLE users ADD COLUMN real_name TEXT DEFAULT \'\''); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN rating REAL DEFAULT 5.0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN wallet_balance REAL DEFAULT 0.00'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN total_orders INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN is_online INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE orders ADD COLUMN rating INTEGER DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE orders ADD COLUMN rating_comment TEXT DEFAULT NULL'); } catch(e) {}

  const campusCount = dbGet('SELECT COUNT(*) AS c FROM campuses');
  if (!campusCount || campusCount.c === 0) {
    const campuses = [
      ['湖北大学 · 武昌校区','友谊大道368号',30.5751,114.3308,1],
      ['一期学生公寓','A/B栋',30.5730,114.3325,2],
      ['二期学生公寓','A-G栋',30.5720,114.3340,3],
      ['团结学生公寓','',30.5770,114.3280,4],
      ['普宿8栋/9栋','',30.5740,114.3290,5],
      ['校外诚信公寓','a/b/c栋',30.5700,114.3360,6],
    ];
    for (const c of campuses) dbRun('INSERT INTO campuses (name,address,lat,lng,sort_order) VALUES (?,?,?,?,?)', c);
  }
  saveDb();
}

// ─── 初始化 ───────────────────────────────────────────
async function startServer() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    try { db = new SQL.Database(fs.readFileSync(DB_PATH)); } catch(e) { db = new SQL.Database(); }
  } else { db = new SQL.Database(); }
  initDatabase();
  console.log('✅ 数据库初始化完成');

  // ─── JWT ────────────────────────────────────────────
  function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' }); }
  function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    try { req.auth = jwt.verify(header.slice(7), JWT_SECRET); next(); }
    catch(e) { return res.status(401).json({ error: '登录已过期' }); }
  }

  // ─── 辅助函数 ────────────────────────────────────────
  function attachRiderInfo(order) {
    if (order && order.rider_id) {
      const rider = dbGet('SELECT id, username, phone, real_name, rating FROM users WHERE id = ?', [order.rider_id]);
      if (rider) { order.rider_name = rider.real_name || rider.username; order.rider_phone = rider.phone; order.rider_rating = rider.rating; }
    }
    return order;
  }

  // ─── 统一认证 ─────────────────────────────────────────
  app.post('/api/auth/register', (req, res) => {
    const { username, password, phone, real_name, campus } = req.body;
    if (!username || !password || !phone) return res.status(400).json({ error: '请填写用户名、密码和手机号' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    if (!/^\d{11}$/.test(phone)) return res.status(400).json({ error: '请输入正确的11位手机号' });
    if (dbGet('SELECT id FROM users WHERE username = ?', [username])) return res.status(409).json({ error: '用户名已被注册' });

    const hash = bcrypt.hashSync(password, 10);
    dbRun('INSERT INTO users (username, password, phone, real_name, campus) VALUES (?,?,?,?,?)',
      [username, hash, phone, real_name || '', campus || '湖北大学 · 武昌校区']);
    const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
    const token = signToken({ id: user.id, username: user.username });
    res.json({ ok: true, token, user: { id: user.id, username, phone, real_name: user.real_name, campus: user.campus, wallet_balance: user.wallet_balance, rating: user.rating, total_orders: user.total_orders } });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '用户名或密码错误' });
    const token = signToken({ id: user.id, username: user.username });
    res.json({ ok: true, token, user: { id: user.id, username, phone: user.phone, real_name: user.real_name, campus: user.campus, wallet_balance: user.wallet_balance, rating: user.rating, total_orders: user.total_orders, is_online: user.is_online } });
  });

  app.get('/api/auth/me', authMiddleware, (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.auth.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    delete user.password;
    res.json(user);
  });

  // ─── 订单 ────────────────────────────────────────────
  app.post('/api/orders', authMiddleware, (req, res) => {
    const { type, title, pickup_addr, delivery_addr, pickup_lat, pickup_lng, delivery_lat, delivery_lng,
      distance_km, details, phone, base_fee, distance_fee, tip, deposit, total_fee, rider_fee, item_info } = req.body;
    if (!type || !pickup_addr || !delivery_addr) return res.status(400).json({ error: '请填写完整地址' });

    const orderNo = 'RUN_' + Date.now() + '_' + Math.random().toString(36).slice(2,6).toUpperCase();
    dbRun(`INSERT INTO orders (order_no, user_id, type, title, pickup_addr, delivery_addr,
      pickup_lat, pickup_lng, delivery_lat, delivery_lng, distance_km, details,
      phone, base_fee, distance_fee, tip, deposit, total_fee, rider_fee, item_info, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [orderNo, req.auth.id, type, title, pickup_addr, delivery_addr, pickup_lat, pickup_lng,
        delivery_lat, delivery_lng, distance_km||0, details||'', phone, base_fee||0, distance_fee||0,
        tip||0, deposit||0, total_fee||0, rider_fee||0, JSON.stringify(item_info||{})]);
    const o = dbGet('SELECT id, order_no FROM orders WHERE order_no = ?', [orderNo]);
    res.json({ ok: true, order: o });
  });

  app.get('/api/orders', authMiddleware, (req, res) => {
    const { my, status } = req.query;
    // 我的订单（作为用户下的单）
    const myOrders = dbAll('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.auth.id]);
    myOrders.forEach(o => { try { o.item_info = JSON.parse(o.item_info||'{}'); } catch(e) { o.item_info = {}; } attachRiderInfo(o); });

    // 任务大厅：待接单
    const pool = dbAll("SELECT * FROM orders WHERE status = 'pending' AND user_id != ? ORDER BY created_at DESC LIMIT 30", [req.auth.id]);
    pool.forEach(o => { try { o.item_info = JSON.parse(o.item_info||'{}'); } catch(e) { o.item_info = {}; } });

    // 我接的单（作为骑手）
    const myActive = dbAll("SELECT * FROM orders WHERE rider_id = ? AND status IN ('accepted','delivering') ORDER BY created_at DESC", [req.auth.id]);
    myActive.forEach(o => { try { o.item_info = JSON.parse(o.item_info||'{}'); } catch(e) { o.item_info = {}; } attachRiderInfo(o); });

    // 骑手历史
    const myRiderHistory = dbAll("SELECT * FROM orders WHERE rider_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 50", [req.auth.id]);
    myRiderHistory.forEach(o => { try { o.item_info = JSON.parse(o.item_info||'{}'); } catch(e) { o.item_info = {}; } });

    res.json({ orders: myOrders, pool, my_active: myActive, rider_history: myRiderHistory });
  });

  app.get('/api/orders/:id', authMiddleware, (req, res) => {
    const order = dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    try { order.item_info = JSON.parse(order.item_info||'{}'); } catch(e) { order.item_info = {}; }
    attachRiderInfo(order);
    res.json({ order });
  });

  app.post('/api/orders/:id/accept', authMiddleware, (req, res) => {
    const order = dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.user_id === req.auth.id) return res.status(400).json({ error: '不能接自己的订单' });
    if (order.status !== 'pending') return res.status(400).json({ error: '订单已被抢或已过期' });
    const check = dbGet("SELECT id FROM orders WHERE id = ? AND status = 'pending'", [req.params.id]);
    if (!check) return res.status(409).json({ error: '手慢一步！已被其他人抢走' });
    dbRun("UPDATE orders SET rider_id = ?, status = 'accepted', accepted_at = datetime('now','localtime') WHERE id = ?", [req.auth.id, req.params.id]);
    res.json({ ok: true });
  });

  app.post('/api/orders/:id/deliver', authMiddleware, (req, res) => {
    const order = dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.rider_id !== req.auth.id) return res.status(403).json({ error: '这不是您的订单' });
    if (order.status !== 'accepted') return res.status(400).json({ error: '状态不正确' });
    dbRun("UPDATE orders SET status = 'delivering', delivered_at = datetime('now','localtime') WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  });

  app.post('/api/orders/:id/confirm', authMiddleware, (req, res) => {
    const order = dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.user_id !== req.auth.id) return res.status(403).json({ error: '仅下单用户可确认收货' });
    if (order.status !== 'delivering') return res.status(400).json({ error: '骑手尚未确认送达' });
    dbRun("UPDATE orders SET status = 'confirmed', confirmed_at = datetime('now','localtime') WHERE id = ?", [order.id]);
    dbRun('UPDATE users SET wallet_balance = wallet_balance + ?, total_orders = total_orders + 1 WHERE id = ?', [order.rider_fee||0, order.rider_id]);
    dbRun('INSERT INTO transactions (order_id, rider_id, user_id, amount, type, description) VALUES (?,?,?,?,?,?)', [order.id, order.rider_id, order.user_id, order.rider_fee||0, 'rider_earning', '配送收入']);
    dbRun('INSERT INTO transactions (order_id, rider_id, user_id, amount, type, description) VALUES (?,?,?,?,?,?)', [order.id, order.rider_id, order.user_id, (order.total_fee||0)-(order.rider_fee||0), 'platform_fee', '平台服务费']);
    if (order.tip > 0) dbRun('INSERT INTO transactions (order_id, rider_id, user_id, amount, type, description) VALUES (?,?,?,?,?,?)', [order.id, order.rider_id, order.user_id, order.tip, 'tip', '小费']);
    saveDb();
    const rider = dbGet('SELECT wallet_balance, total_orders, rating FROM users WHERE id = ?', [order.rider_id]);
    res.json({ ok: true, rider });
  });

  app.post('/api/orders/:id/rate', authMiddleware, (req, res) => {
    const order = dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.user_id !== req.auth.id) return res.status(403).json({ error: '无权评价' });
    if (order.status !== 'confirmed') return res.status(400).json({ error: '订单未完成' });
    if (order.rating) return res.status(400).json({ error: '已评价过' });
    const { rating, comment } = req.body;
    const r = parseInt(rating);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: '评分1-5分' });
    dbRun('UPDATE orders SET rating = ?, rating_comment = ? WHERE id = ?', [r, comment||'', order.id]);
    const avg = dbGet('SELECT AVG(rating) AS a, COUNT(*) AS c FROM orders WHERE rider_id = ? AND rating IS NOT NULL', [order.rider_id]);
    if (avg && avg.c > 0) dbRun('UPDATE users SET rating = ? WHERE id = ?', [Math.round(avg.a*10)/10, order.rider_id]);
    saveDb();
    res.json({ ok: true, new_rating: avg ? Math.round(avg.a*10)/10 : 5.0 });
  });

  app.post('/api/orders/:id/cancel', authMiddleware, (req, res) => {
    const order = dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'confirmed' || order.status === 'cancelled') return res.status(400).json({ error: '无法取消' });
    const { reason } = req.body;
    if (order.user_id === req.auth.id) {
      if (order.status !== 'pending') return res.status(400).json({ error: '骑手已接单，请联系骑手协商' });
    } else if (order.rider_id === req.auth.id) {
      if (order.status !== 'accepted') return res.status(400).json({ error: '当前状态无法取消' });
    } else {
      return res.status(403).json({ error: '无权操作' });
    }
    dbRun("UPDATE orders SET status = 'cancelled', details = details || ? WHERE id = ?", [' [取消: '+(reason||'无')+']', order.id]);
    saveDb();
    res.json({ ok: true });
  });

  // ─── 用户功能 ─────────────────────────────────────────
  app.post('/api/user/toggle-online', authMiddleware, (req, res) => {
    const user = dbGet('SELECT is_online FROM users WHERE id = ?', [req.auth.id]);
    const ns = user.is_online ? 0 : 1;
    dbRun('UPDATE users SET is_online = ? WHERE id = ?', [ns, req.auth.id]);
    saveDb();
    res.json({ ok: true, is_online: !!ns });
  });

  app.get('/api/user/stats', authMiddleware, (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.auth.id]);
    const todayEarn = dbGet("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE rider_id = ? AND date(created_at)=date('now','localtime') AND type='rider_earning'", [req.auth.id]);
    res.json({
      wallet_balance: user.wallet_balance, total_orders: user.total_orders,
      rating: user.rating, is_online: user.is_online,
      today_earnings: todayEarn ? todayEarn.s : 0
    });
  });

  // 兼容旧接口
  app.get('/api/rider/stats', authMiddleware, (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.auth.id]);
    const todayEarn = dbGet("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE rider_id = ? AND date(created_at)=date('now','localtime') AND type='rider_earning'", [req.auth.id]);
    const todayOrd = dbGet("SELECT COUNT(*) AS c FROM orders WHERE rider_id = ? AND status='confirmed' AND date(confirmed_at)=date('now','localtime')", [req.auth.id]);
    res.json({ wallet_balance: user.wallet_balance, total_orders: user.total_orders, rating: user.rating, today_earnings: todayEarn?todayEarn.s:0, today_orders: todayOrd?todayOrd.c:0, is_online: user.is_online });
  });

  app.get('/api/rider/history', authMiddleware, (req, res) => {
    const orders = dbAll("SELECT * FROM orders WHERE rider_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 50", [req.auth.id]);
    const transactions = dbAll('SELECT * FROM transactions WHERE rider_id = ? ORDER BY created_at DESC LIMIT 100', [req.auth.id]);
    res.json({ orders, transactions });
  });

  app.get('/api/lobby/stats', (req, res) => {
    const online = dbGet('SELECT COUNT(*) AS c FROM users WHERE is_online = 1');
    const pending = dbGet("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'");
    res.json({ online_riders: online?online.c:0, pending_orders: pending?pending.c:0 });
  });

  app.get('/api/campuses', (req, res) => {
    res.json({ campuses: dbAll('SELECT * FROM campuses ORDER BY sort_order') });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // ─── 启动 ─────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`   📄 首页:  http://localhost:${PORT}/index.html`);
    console.log(`   🔑 登录:  http://localhost:${PORT}/login.html`);
    console.log(`   🏍️ 接单:  http://localhost:${PORT}/runner.html`);
  });
}

startServer().catch(err => { console.error('启动失败:', err); process.exit(1); });
