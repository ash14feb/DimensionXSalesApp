
const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/cash/open
// @desc    Open cash register for the day
// @access  Private (Staff, Manager, Admin)
router.post('/open', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, opening_cash, notes } = req.body;
        const user_id = req.user.user_id;
        const today = new Date().toISOString().split('T')[0];

        // Check if register is already opened today
        const [existingRegister] = await db.query(
            'SELECT * FROM cash_register WHERE store_id = ? AND register_date = ?',
            [store_id, today]
        );

        if (existingRegister.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cash register already opened for today'
            });
        }

        // Open cash register
        const result = await db.query(
            `INSERT INTO cash_register (
        store_id, user_id, register_date, opening_cash, notes
      ) VALUES (?, ?, ?, ?, ?)`,
            [store_id, user_id, today, opening_cash, notes]
        );

        // Get store info
        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Cash register opened successfully',
            register_id: result.insertId,
            store_name: stores[0]?.store_name,
            date: today,
            opening_cash: parseFloat(opening_cash)
        });
    } catch (error) {
        console.error('Open cash register error:', error);
        res.status(500).json({
            success: false,
            message: 'Error opening cash register'
        });
    }
});

// @route   POST /api/cash/close
// @desc    Close cash register for the day
// @access  Private (Staff, Manager, Admin)
router.post('/close', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, closing_cash, notes } = req.body;
        const user_id = req.user.user_id;
        const today = new Date().toISOString().split('T')[0];

        // Check if register is opened today
        const [register] = await db.query(
            'SELECT * FROM cash_register WHERE store_id = ? AND register_date = ?',
            [store_id, today]
        );

        if (register.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Cash register not opened for today'
            });
        }

        if (register[0].closing_cash !== null) {
            return res.status(400).json({
                success: false,
                message: 'Cash register already closed for today'
            });
        }

        // Get today's cash sales
        const [cashSales] = await db.query(
            'SELECT COALESCE(SUM(cash_amount), 0) as total_cash_sales FROM sales WHERE store_id = ? AND sale_date = ?',
            [store_id, today]
        );

        const total_cash_sales = parseFloat(cashSales[0]?.total_cash_sales || 0);
        const opening_cash = parseFloat(register[0].opening_cash);
        const calculated_cash = opening_cash + total_cash_sales;
        const cash_difference = parseFloat(closing_cash) - calculated_cash;

        // Close cash register
        await db.query(
            `UPDATE cash_register SET
        closing_cash = ?,
        calculated_cash = ?,
        cash_difference = ?,
        closing_time = NOW(),
        notes = CONCAT_WS(' | ', notes, ?)
      WHERE store_id = ? AND register_date = ?`,
            [closing_cash, calculated_cash, cash_difference, notes, store_id, today]
        );

        // Get store info
        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.json({
            success: true,
            message: 'Cash register closed successfully',
            store_name: stores[0]?.store_name,
            date: today,
            opening_cash,
            closing_cash: parseFloat(closing_cash),
            total_cash_sales,
            calculated_cash,
            cash_difference
        });
    } catch (error) {
        console.error('Close cash register error:', error);
        res.status(500).json({
            success: false,
            message: 'Error closing cash register'
        });
    }
});

// @route   GET /api/cash/today
// @desc    Get today's cash register status
// @access  Private (Staff, Manager, Admin)
router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user = req.user;
        const today = new Date().toISOString().split('T')[0];

        let query = `
      SELECT 
        cr.*,
        s.store_name,
        u.full_name as opened_by_name
      FROM cash_register cr
      JOIN stores s ON cr.store_id = s.store_id
      JOIN users u ON cr.user_id = u.user_id
      WHERE cr.register_date = ?
    `;

        const params = [today];

        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND cr.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        query += ' ORDER BY s.store_name';

        const registers = await db.query(query, params);

        // Get cash sales for each store
        for (let register of registers) {
            const [sales] = await db.query(
                'SELECT COALESCE(SUM(cash_amount), 0) as cash_sales FROM sales WHERE store_id = ? AND sale_date = ?',
                [register.store_id, today]
            );
            register.cash_sales_today = parseFloat(sales[0]?.cash_sales || 0);
        }

        res.json({
            success: true,
            date: today,
            registers
        });
    } catch (error) {
        console.error('Get cash register status error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching cash register status'
        });
    }
});

// @route   GET /api/cash/history
// @desc    Get cash register history
// @access  Private (Manager, Admin)
router.get('/history', authorize('manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            start_date,
            end_date,
            page = 1,
            limit = 50
        } = req.query;

        const offset = (page - 1) * limit;

        let query = `
      SELECT 
        cr.*,
        s.store_name,
        u.full_name as opened_by_name
      FROM cash_register cr
      JOIN stores s ON cr.store_id = s.store_id
      JOIN users u ON cr.user_id = u.user_id
      WHERE 1=1
    `;

        const params = [];

        if (store_id) {
            query += ' AND cr.store_id = ?';
            params.push(store_id);
        }

        if (start_date) {
            query += ' AND cr.register_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND cr.register_date <= ?';
            params.push(end_date);
        }

        query += ' ORDER BY cr.register_date DESC, s.store_name LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const registers = await db.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM cash_register cr WHERE 1=1';
        const countParams = params.slice(0, -2);

        if (store_id) countQuery += ' AND cr.store_id = ?';
        if (start_date) countQuery += ' AND cr.register_date >= ?';
        if (end_date) countQuery += ' AND cr.register_date <= ?';

        const [countResult] = await db.query(countQuery, countParams);
        const total = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: registers,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get cash register history error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching cash register history'
        });
    }
});

module.exports = router;