const express = require('express');
const router = express.Router();
const db = require('../utils/dbdreamcube');
const { authMiddleware, authorize } = require('../middleware/auth');

// Admin only - reads from the `dreamcubeonline` database
router.use(authMiddleware);
router.use(authorize('admin'));

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MAX_RECORDS = 1000;

const normalizeDate = (value) => (DATE_PATTERN.test(String(value || '')) ? String(value) : null);

const normalizePayment = (value) => {
    const method = String(value || '').trim().toLowerCase();
    if (!method) return 'other';
    if (method.includes('upi') || method.includes('paytm') || method.includes('gpay') || method.includes('phonepe')) return 'upi';
    if (method.includes('cash')) return 'cash';
    if (method.includes('card') || method.includes('credit') || method.includes('debit')) return 'card';
    return method;
};

const collectStaffNames = (value, output) => {
    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return;
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                collectStaffNames(JSON.parse(trimmed), output);
                return;
            } catch (error) {
                output.push(trimmed);
                return;
            }
        }
        output.push(trimmed);
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((item) => collectStaffNames(item, output));
        return;
    }

    if (typeof value === 'object') {
        if (typeof value.name === 'string' && value.name.trim()) {
            output.push(value.name.trim());
            return;
        }
        if (typeof value.full_name === 'string' && value.full_name.trim()) {
            output.push(value.full_name.trim());
            return;
        }
        Object.values(value).forEach((item) => collectStaffNames(item, output));
    }
};

const parseStaffNames = (value) => {
    const names = [];
    collectStaffNames(value, names);
    return [...new Set(names)];
};

// @route   POST /api/dreamcube/report
// @desc    Sales report (summary, payment split, staff performance, records)
// @access  Private (Admin)
router.post('/report', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        let fromDate = normalizeDate(req.body.from_date) || today;
        let toDate = normalizeDate(req.body.to_date) || today;

        if (fromDate > toDate) {
            [fromDate, toDate] = [toDate, fromDate];
        }

        const fromDateTime = `${fromDate} 00:00:00`;
        const toDateTime = `${toDate} 23:59:59`;

        const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 500, 1), MAX_RECORDS);

        const [totalsRows, paymentRows, staffRows, records] = await Promise.all([
            db.query(
                `SELECT
                    COUNT(*) as total_transactions,
                    IFNULL(SUM(total),0) as total_sales,
                    IFNULL(SUM(subtotal),0) as subtotal,
                    IFNULL(SUM(discount),0) as total_discount,
                    IFNULL(SUM(totalPeople),0) as total_people,
                    IFNULL(SUM(adults),0) as adults,
                    IFNULL(SUM(kids),0) as kids
                 FROM sales
                 WHERE createdAt >= ? AND createdAt <= ?`,
                [fromDateTime, toDateTime]
            ),
            db.query(
                `SELECT
                    LOWER(TRIM(COALESCE(paymentMethod,''))) as payment_method,
                    COUNT(*) as transactions,
                    IFNULL(SUM(total),0) as amount,
                    IFNULL(SUM(totalPeople),0) as people
                 FROM sales
                 WHERE createdAt >= ? AND createdAt <= ?
                 GROUP BY 1
                 ORDER BY amount DESC`,
                [fromDateTime, toDateTime]
            ),
            db.query(
                `SELECT staffNames, total, totalPeople
                 FROM sales
                 WHERE createdAt >= ? AND createdAt <= ?`,
                [fromDateTime, toDateTime]
            ),
            db.query(
                `SELECT *
                 FROM sales
                 WHERE createdAt >= ? AND createdAt <= ?
                 ORDER BY createdAt DESC
                 LIMIT ${limit}`,
                [fromDateTime, toDateTime]
            )
        ]);

        const totals = totalsRows[0] || {};

        const paymentBuckets = { upi: { amount: 0, transactions: 0, people: 0 }, cash: { amount: 0, transactions: 0, people: 0 }, card: { amount: 0, transactions: 0, people: 0 }, other: { amount: 0, transactions: 0, people: 0 } };

        paymentRows.forEach((row) => {
            const bucket = paymentBuckets[normalizePayment(row.payment_method)] || paymentBuckets.other;
            bucket.amount += Number(row.amount) || 0;
            bucket.transactions += Number(row.transactions) || 0;
            bucket.people += Number(row.people) || 0;
        });

        const payment_breakdown = Object.keys(paymentBuckets)
            .filter((method) => paymentBuckets[method].transactions > 0)
            .map((method) => ({ method, ...paymentBuckets[method] }));

        const staffMap = {};
        staffRows.forEach((row) => {
            const names = parseStaffNames(row.staffNames);
            const list = names.length > 0 ? names : ['Unassigned'];
            const share = Number(row.total) || 0;
            const people = Number(row.totalPeople) || 0;
            list.forEach((name) => {
                if (!staffMap[name]) {
                    staffMap[name] = { staff_name: name, transactions: 0, amount: 0, people: 0 };
                }
                staffMap[name].transactions += 1;
                staffMap[name].amount += share;
                staffMap[name].people += people;
            });
        });

        const staff_breakdown = Object.values(staffMap).sort((a, b) => b.amount - a.amount);

        res.json({
            success: true,
            range: { from_date: fromDate, to_date: toDate },
            summary: {
                total_transactions: Number(totals.total_transactions) || 0,
                total_sales: Number(totals.total_sales) || 0,
                subtotal: Number(totals.subtotal) || 0,
                total_discount: Number(totals.total_discount) || 0,
                total_people: Number(totals.total_people) || 0,
                adults: Number(totals.adults) || 0,
                kids: Number(totals.kids) || 0,
                upi: paymentBuckets.upi.amount,
                cash: paymentBuckets.cash.amount,
                card: paymentBuckets.card.amount,
                other: paymentBuckets.other.amount
            },
            payment_breakdown,
            staff_breakdown,
            records,
            record_count: records.length
        });
    } catch (error) {
        console.error('DreamCube report error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;
