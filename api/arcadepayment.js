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

        const [rows] = await db.query(query, [from_date, to_date]);
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

module.exports = router;