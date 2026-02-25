const express = require('express');
const router = express.Router();
const db = require('../utils/dbarcade'); // your mysql2 pool

router.post('/date-range', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const query = `
            SELECT *
            FROM es_payment
            WHERE DATE(created_at) BETWEEN ? AND ?
              AND is_deleted = 'NO'
            ORDER BY created_at DESC
        `;

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const rows = await db.query(query, [fromDateTime, toDateTime]);
        console.log("Rows length:", rows.length);
        console.log("Rows:", rows);
        res.json({
            success: true,
            count: rows.length,
            data: rows
        });

    } catch (error) {
        console.error("ArcadePayment date range error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});


router.post('/date-range-summary', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        // 1️⃣ Total transactions + total sales
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_customers,
                SUM(recharge_amount) as total_sales
            FROM es_payment
            WHERE created_at >= ?
              AND created_at <= ?
              AND is_deleted = 'NO'
        `;

        // 2️⃣ Recharge amount grouping
        const groupingQuery = `
            SELECT 
                recharge_amount,
                COUNT(*) as customer_count
            FROM es_payment
            WHERE created_at >= ?
              AND created_at <= ?
              AND is_deleted = 'NO'
            GROUP BY recharge_amount
            ORDER BY recharge_amount ASC
        `;

        const summary = await db.query(summaryQuery, [fromDateTime, toDateTime]);
        const grouping = await db.query(groupingQuery, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            summary: summary[0],
            recharge_breakdown: grouping
        });

    } catch (error) {
        console.error("ArcadePayment summary error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});
module.exports = router;