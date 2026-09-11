const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

router.use(authMiddleware);

const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const dailyTarget = (monthly, y, m) => {
  const d = daysInMonth(y, m);
  return d > 0 ? Number(monthly || 0) / d : 0;
};

// GET /api/targets?year=YYYY&month=M -> single month row
router.get('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const month = parseInt(req.query.month);
    if (!year || !month) return res.status(400).json({ success: false, message: 'year and month required' });
    const rows = await db.query('SELECT * FROM monthly_targets WHERE target_year=? AND target_month=?', [year, month]);
    const row = rows[0] || null;
    const dim = daysInMonth(year, month);
    res.json({
      success: true, data: row,
      daily: row ? {
        arcade: Math.round(dailyTarget(row.arcade_target, year, month)),
        dreamcube: Math.round(dailyTarget(row.dreamcube_target, year, month)),
        spacewalk: Math.round(dailyTarget(row.spacewalk_target, year, month)),
        daysInMonth: dim
      } : null
    });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error fetching targets' }); }
});

// POST /api/targets (admin/manager) upsert
router.post('/', authorize('manager', 'admin'), async (req, res) => {
  try {
    const { year, month, arcade_target = 0, dreamcube_target = 0, spacewalk_target = 0 } = req.body;
    if (!year || !month) return res.status(400).json({ success: false, message: 'year and month required' });
    const createdBy = req.user?.username || req.user?.full_name || '';
    await db.query(
      `INSERT INTO monthly_targets (target_year, target_month, arcade_target, dreamcube_target, spacewalk_target, created_by)
       VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE arcade_target=VALUES(arcade_target), dreamcube_target=VALUES(dreamcube_target), spacewalk_target=VALUES(spacewalk_target), created_by=VALUES(created_by)`,
      [year, month, arcade_target, dreamcube_target, spacewalk_target, createdBy]
    );
    res.json({ success: true, message: 'Monthly targets saved' });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error saving targets' }); }
});

// GET /api/targets/today -> today's daily targets for current month
router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;
    const rows = await db.query('SELECT * FROM monthly_targets WHERE target_year=? AND target_month=?', [year, month]);
    const row = rows[0] || null;
    if (!row) return res.json({ success: true, data: null });
    const dim = daysInMonth(year, month);
    res.json({ success: true, data: row, daily: {
      arcade: Math.round(Number(row.arcade_target) / dim),
      dreamcube: Math.round(Number(row.dreamcube_target) / dim),
      spacewalk: Math.round(Number(row.spacewalk_target) / dim),
      daysInMonth: dim, year, month
    }});
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error fetching today targets' }); }
});

// GET /api/targets/calendar?year=&month=&store=arcade|dreamcube|spacewalk
// Returns per-day { date, target, actual, achieved }
router.get('/calendar', authorize('staff', 'manager', 'admin'), async (req, res) => {
  try {
    const year = parseInt(req.query.year), month = parseInt(req.query.month);
    const store = (req.query.store || 'arcade').toLowerCase();
    if (!year || !month) return res.status(400).json({ success: false, message: 'year and month required' });
    const storeId = store === 'dreamcube' ? 2 : store === 'spacewalk' ? 4 : 1;
    const trows = await db.query('SELECT * FROM monthly_targets WHERE target_year=? AND target_month=?', [year, month]);
    const t = trows[0];
    const monthly = t ? Number(store === 'dreamcube' ? t.dreamcube_target : store === 'spacewalk' ? t.spacewalk_target : t.arcade_target) : 0;
    const dim = daysInMonth(year, month);
    const perDay = dim > 0 ? monthly / dim : 0;
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const sales = await db.query(
      `SELECT DATE(sale_date) AS d, COALESCE(SUM(total_amount),0) AS actual FROM sales WHERE store_id=? AND sale_date >= ? AND sale_date < LAST_DAY(?)+INTERVAL 1 DAY GROUP BY DATE(sale_date)`,
      [storeId, first, first]
    );
    const map = {};
    sales.forEach(r => { const k = String(r.d).substring(0, 10); map[k] = Number(r.actual) || 0; });
    const days = [];
    for (let d = 1; d <= dim; d++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const actual = Math.round(map[date] || 0);
      const target = Math.round(perDay);
      days.push({ date, day: d, target, actual, achieved: target > 0 && actual >= target });
    }
    res.json({ success: true, store, store_id: storeId, monthly_target: monthly, daily_target: Math.round(perDay), days });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error fetching target calendar' }); }
});

module.exports = router;
