const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// ---- PUBLIC staff display endpoint (no login required) ----
// GET /api/targets/display -> today targets (same Generate-Targets logic + 2500 buffer)
// + monthly targets + month-to-date achieved. Shareable with staff.
router.get('/display', async (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth() + 1;
    const ms = String(month).padStart(2, '0');
    const trows = await db.query('SELECT * FROM monthly_targets WHERE target_year=? AND target_month=?', [year, month]);
    const t = trows[0];
    if (!t) return res.json({ success: true, data: null, message: 'No targets set for this month' });
    const monthly = {
      arcade: Number(t.arcade_target) || 0,
      dreamcube: Number(t.dreamcube_target) || 0,
      spacewalk: Number(t.spacewalk_target) || 0
    };
    const prevRows = await db.query(
      `SELECT s.sale_date,
        COALESCE(SUM(CASE WHEN s.store_id=1 THEN s.total_amount END),0) AS arcade_total_sales,
        COALESCE(SUM(CASE WHEN s.store_id=2 THEN s.total_amount END),0) AS dreamcube_total_sales,
        COALESCE(SUM(CASE WHEN s.store_id=4 THEN s.total_amount END),0) AS toys_total_sales
       FROM sales s WHERE s.sale_date >= ? AND s.sale_date < ? GROUP BY s.sale_date`,
      [`${year - 1}-${ms}-01`, `${year}-${ms}-01`]
    ).catch(() => []);
    const currRows = await db.query(
      `SELECT s.sale_date,
        COALESCE(SUM(CASE WHEN s.store_id=1 THEN s.total_amount END),0) AS arcade_total_sales,
        COALESCE(SUM(CASE WHEN s.store_id=2 THEN s.total_amount END),0) AS dreamcube_total_sales,
        COALESCE(SUM(CASE WHEN s.store_id=4 THEN s.total_amount END),0) AS toys_total_sales
       FROM sales s WHERE s.sale_date >= ? AND s.sale_date < LAST_DAY(?)+INTERVAL 1 DAY GROUP BY s.sale_date`,
      [`${year}-${ms}-01`, `${year}-${ms}-01`]
    ).catch(() => []);
    const key = (v) => String(v).substring(0, 10);
    const stat = (field) => {
      let w = 0, wc = 0, sa = 0, sac = 0, su = 0, suc = 0;
      prevRows.forEach((r) => {
        const ds = key(r.sale_date); if (!ds.startsWith(`${year - 1}-${ms}`)) return;
        const v = Number(r[field]) || 0; if (!v) return;
        const dow = new Date(year - 1, month - 1, parseInt(ds.split('-')[2], 10)).getDay();
        if (dow === 0) { su += v; suc++; } else if (dow === 6) { sa += v; sac++; } else { w += v; wc++; }
      });
      return { avgW: wc ? w / wc : 0, avgSa: sac ? sa / sac : 0, avgSu: suc ? su / suc : 0 };
    };
    const maxDay = now.getDate();
    const dim = daysInMonth(year, month);
    const achieved = { arcade: 0, dreamcube: 0, spacewalk: 0 };
    currRows.forEach((r) => {
      const ds = key(r.sale_date); if (!ds.startsWith(`${year}-${ms}`)) return;
      const d = parseInt(ds.split('-')[2], 10);
      achieved.arcade += Number(r.arcade_total_sales) || 0;
      achieved.dreamcube += Number(r.dreamcube_total_sales) || 0;
      achieved.spacewalk += Number(r.toys_total_sales) || 0;
      void d;
    });
    // MTD only up to today
    const mtd = { arcade: 0, dreamcube: 0, spacewalk: 0 };
    currRows.forEach((r) => {
      const ds = key(r.sale_date);
      const d = parseInt(ds.split('-')[2], 10);
      if (d <= maxDay) {
        mtd.arcade += Number(r.arcade_total_sales) || 0;
        mtd.dreamcube += Number(r.dreamcube_total_sales) || 0;
        mtd.spacewalk += Number(r.toys_total_sales) || 0;
      }
    });
    const dow = now.getDay();
    const rev = (target, ach, s) => {
      let rw = 0, rs = 0, ru = 0;
      for (let d = maxDay + 1; d <= dim; d++) {
        const w = new Date(year, month - 1, d).getDay();
        if (w === 0) ru++; else if (w === 6) rs++; else rw++;
      }
      const rem = target - ach;
      const ratio = s.avgW * rw + s.avgSa * rs + s.avgSu * ru;
      if (ratio > 0 && rem > 0) {
        if (dow === 0) return (s.avgSu * rem) / ratio;
        if (dow === 6) return (s.avgSa * rem) / ratio;
        return (s.avgW * rem) / ratio;
      }
      const remDays = dim - maxDay;
      if (remDays > 0 && rem > 0) return rem / remDays;
      return dim ? target / dim : 0;
    };
    const BUFFER = 2500;
    res.json({ success: true, year, month, date: now.toISOString().slice(0, 10),
      monthly, mtd: { arcade: Math.round(mtd.arcade), dreamcube: Math.round(mtd.dreamcube), spacewalk: Math.round(mtd.spacewalk) },
      today: {
        arcade: Math.round(rev(monthly.arcade, mtd.arcade, stat('arcade_total_sales'))) + BUFFER,
        dreamcube: Math.round(rev(monthly.dreamcube, mtd.dreamcube, stat('dreamcube_total_sales'))) + BUFFER,
        spacewalk: Math.round(rev(monthly.spacewalk, mtd.spacewalk, stat('toys_total_sales'))) + BUFFER
      } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error loading staff targets' }); }
});

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
