const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// ---- PUBLIC staff display endpoint (no login required) ----
// GET /api/targets/display -> today targets (same Generate-Targets logic + 2500 buffer)
// + monthly targets + month-to-date achieved. Shareable with staff.
router.get('/display', async (req, res) => {
  try {
    // Use the date passed by the viewer (IST from browser) so the numbers
    // match the Entry screen exactly; fall back to server date.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.query.date || ''));
    const ref = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`) : new Date();
    const year = ref.getFullYear(), month = ref.getMonth() + 1;
    const now = ref;
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
    const key = (v) => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'string') {
        const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
        if (mm) return `${mm[1]}-${mm[2]}-${mm[3]}`;
        const p = new Date(v);
        if (!isNaN(p)) return p.toISOString().slice(0, 10);
      }
      return String(v).substring(0, 10);
    };
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
    // Month-to-date achieved (only days up to today) — same as Entry screen
    const mtd = { arcade: 0, dreamcube: 0, spacewalk: 0 };
    currRows.forEach((r) => {
      const ds = key(r.sale_date); if (!ds.startsWith(`${year}-${ms}`)) return;
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
    const BUFFER = { arcade: 2000, dreamcube: 500, spacewalk: 100 };
    // Friday = fixed final targets (no buffer); otherwise computed + buffer
    const isFriday = dow === 5;
    res.json({ success: true, year, month, date: now.toISOString().slice(0, 10),
      monthly, mtd: { arcade: Math.round(mtd.arcade), dreamcube: Math.round(mtd.dreamcube), spacewalk: Math.round(mtd.spacewalk) },
      today: {
        arcade: isFriday ? 16000 : Math.round(rev(monthly.arcade, mtd.arcade, stat('arcade_total_sales'))) + BUFFER.arcade,
        dreamcube: isFriday ? 5000 : Math.round(rev(monthly.dreamcube, mtd.dreamcube, stat('dreamcube_total_sales'))) + BUFFER.dreamcube,
        spacewalk: Math.round(rev(monthly.spacewalk, mtd.spacewalk, stat('toys_total_sales'))) + BUFFER.spacewalk
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
    // Overlay recorded achievement status captured at sales-entry save time
    try {
      const recs = await db.query(
        `SELECT target_date, target_value, actual_value, achieved FROM target_achievements WHERE store=? AND target_date >= ? AND target_date < LAST_DAY(?)+INTERVAL 1 DAY`,
        [store, first, first]
      );
      const rmap = {};
      recs.forEach(r => {
        const k = r.target_date instanceof Date ? r.target_date.toISOString().slice(0, 10) : String(r.target_date).substring(0, 10);
        rmap[k] = r;
      });
      days.forEach(d => {
        const r = rmap[d.date];
        if (r) {
          d.target = Math.round(Number(r.target_value) || 0);
          d.actual = Math.round(Number(r.actual_value) || 0);
          d.achieved = Number(r.achieved) === 1;
          d.recorded = true;
        }
      });
    } catch (_) { /* table may not exist yet */ }
    res.json({ success: true, store, store_id: storeId, monthly_target: monthly, daily_target: Math.round(perDay), days });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error fetching target calendar' }); }
});

// POST /api/targets/record — capture per-day achievement at sales-entry save
// Body: { date: YYYY-MM-DD, records: [{ store, target_value, actual_value }] }
router.post('/record', authorize('staff', 'manager', 'admin'), async (req, res) => {
  try {
    const { date, records } = req.body;
    if (!date || !Array.isArray(records)) return res.status(400).json({ success: false, message: 'date and records required' });
    for (const r of records) {
      const store = String(r.store || '').toLowerCase();
      if (!['arcade', 'dreamcube', 'spacewalk'].includes(store)) continue;
      const tv = Number(r.target_value) || 0, av = Number(r.actual_value) || 0;
      const ach = tv > 0 && av >= tv ? 1 : 0;
      await db.query(
        `INSERT INTO target_achievements (target_date, store, target_value, actual_value, achieved)
         VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE target_value=VALUES(target_value), actual_value=VALUES(actual_value), achieved=VALUES(achieved)`,
        [date, store, tv, av, ach]
      );
    }
    res.json({ success: true, message: 'Target achievements recorded' });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error recording achievements' }); }
});

// GET /api/targets/achievements?year=&month=&store=
router.get('/achievements', authorize('staff', 'manager', 'admin'), async (req, res) => {
  try {
    const year = parseInt(req.query.year), month = parseInt(req.query.month);
    const store = String(req.query.store || 'arcade').toLowerCase();
    if (!year || !month) return res.status(400).json({ success: false, message: 'year and month required' });
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const rows = await db.query(
      `SELECT target_date, store, target_value, actual_value, achieved FROM target_achievements WHERE store=? AND target_date >= ? AND target_date < LAST_DAY(?)+INTERVAL 1 DAY ORDER BY target_date`,
      [store, first, first]
    );
    res.json({ success: true, data: rows });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Error fetching achievements' }); }
});

module.exports = router;
