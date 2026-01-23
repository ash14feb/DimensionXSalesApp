
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
        const { store_id, opening_cash, notes, date } = req.body;
        const user_id = req.user.user_id;
        const today = date;

        // Check if register is already opened today
        const existingRegister = await db.query(
            'SELECT * FROM cash_register WHERE store_id = ? AND register_date = ?',
            [store_id, today]
        );

        if (existingRegister.length > 0) {
            await db.query(
                `UPDATE cash_register SET
        opening_cash = ?,
        notes = CONCAT_WS(' | ', notes, ?)
      WHERE store_id = ? AND register_date = ?`,
                [opening_cash, notes, store_id, today]
            );
            return res.status(400).json({
                success: false,
                message: 'Cash register already opened for today and it updated'
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
        const { store_id, closing_cash, notes, date } = req.body;
        const user_id = req.user.user_id;
        const today = date;

        // Check if register is opened today
        const register = await db.query(
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
        const cashSales = await db.query(
            'SELECT COALESCE(SUM(cash_amount), 0) as total_cash_sales FROM sales WHERE store_id  IN (1,2,3,4) AND sale_date = ?',
            [today]
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
        const today = req.query.date; // Extract the date parameter

        if (!today) {
            return res.status(400).json({
                success: false,
                message: 'Date parameter is required'
            });
        }

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
            const stores = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND cr.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        query += ' ORDER BY s.store_name';
        console.log("Query:", query, "Params:", params);

        const registers = await db.query(query, params);

        // Get cash sales for each store
        for (let register of registers) {
            const sales = await db.query(
                'SELECT COALESCE(SUM(cash_amount), 0) as cash_sales FROM sales WHERE store_id = ? AND sale_date = ?',
                [register.store_id, today]
            );
            register.cash_sales_today = parseFloat(sales[0]?.cash_sales || 0);
        }

        res.json({
            success: true,
            date: today, // Now returns just the date string
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


// @route   GET /api/cash/monthly
// @desc    Get cash registers by month and year
// @access  Private (Staff, Manager, Admin)
router.get('/monthly', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user = req.user;
        const { year, month, store_id } = req.query;

        // Validate required parameters
        if (!year || !month) {
            return res.status(400).json({
                success: false,
                message: 'Year and month parameters are required'
            });
        }

        // Validate month format (1-12)
        const monthNum = parseInt(month);
        if (monthNum < 1 || monthNum > 12) {
            return res.status(400).json({
                success: false,
                message: 'Month must be between 1 and 12'
            });
        }

        // Validate year format
        const yearNum = parseInt(year);
        if (yearNum < 2000 || yearNum > 2100) {
            return res.status(400).json({
                success: false,
                message: 'Year must be between 2000 and 2100'
            });
        }

        // Format dates for query
        const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
        const endDate = new Date(yearNum, monthNum, 0).toISOString().split('T')[0]; // Last day of month

        let query = `
            SELECT 
                cr.*,
                s.store_name,
                s.store_type,
                u.full_name as opened_by_name,
                COALESCE(SUM(sales.cash_amount), 0) as total_cash_sales
            FROM cash_register cr
            JOIN stores s ON cr.store_id = s.store_id
            JOIN users u ON cr.user_id = u.user_id
            LEFT JOIN sales ON sales.store_id = cr.store_id 
                AND DATE(sales.sale_date) = cr.register_date
            WHERE cr.register_date >= ? 
                AND cr.register_date <= ?
        `;

        const params = [startDate, endDate];

        // Add store filter if provided
        if (store_id) {
            query += ' AND cr.store_id = ?';
            params.push(store_id);
        }

        // Add user permission filter
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const stores = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                const storeIds = stores.map(s => s.store_id);
                if (store_id && !storeIds.includes(parseInt(store_id))) {
                    return res.status(403).json({
                        success: false,
                        message: 'You are not authorized to view this store'
                    });
                }

                if (!store_id) {
                    query += ' AND cr.store_id IN (?)';
                    params.push(storeIds);
                }
            }
        }

        query += `
            GROUP BY cr.register_id, s.store_name, s.store_type, u.full_name
            ORDER BY cr.register_date DESC, s.store_name
        `;

        console.log("Monthly Query:", query, "Params:", params);

        const registers = await db.query(query, params);

        // Calculate monthly statistics
        const stats = calculateMonthlyStats(registers);

        res.json({
            success: true,
            month: `${year}-${month.toString().padStart(2, '0')}`,
            start_date: startDate,
            end_date: endDate,
            total_days: new Date(yearNum, monthNum, 0).getDate(),
            data: registers,
            statistics: stats
        });

    } catch (error) {
        console.error('Get monthly cash registers error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching monthly cash registers'
        });
    }
});

// Helper function to calculate monthly statistics
function calculateMonthlyStats(registers) {
    const stats = {
        total_opening_cash: 0,
        total_closing_cash: 0,
        total_calculated_cash: 0,
        total_cash_difference: 0,
        total_cash_sales: 0,
        days_opened: 0,
        days_closed: 0,
        perfect_matches: 0, // cash_difference = 0
        variances: 0, // cash_difference != 0
        store_breakdown: {}
    };

    registers.forEach(register => {
        const storeType = register.store_type || 'unknown';

        // Initialize store breakdown if not exists
        if (!stats.store_breakdown[storeType]) {
            stats.store_breakdown[storeType] = {
                total_opening_cash: 0,
                total_closing_cash: 0,
                total_calculated_cash: 0,
                total_cash_difference: 0,
                total_cash_sales: 0,
                days_opened: 0,
                days_closed: 0
            };
        }

        // Convert string values to numbers
        const openingCash = parseFloat(register.opening_cash) || 0;
        const closingCash = parseFloat(register.closing_cash) || 0;
        const calculatedCash = parseFloat(register.calculated_cash) || 0;
        const cashDifference = parseFloat(register.cash_difference) || 0;
        const cashSales = parseFloat(register.total_cash_sales) || 0;

        // Update overall stats
        stats.total_opening_cash += openingCash;
        stats.total_closing_cash += closingCash;
        stats.total_calculated_cash += calculatedCash;
        stats.total_cash_difference += cashDifference;
        stats.total_cash_sales += cashSales;

        // Update store breakdown
        stats.store_breakdown[storeType].total_opening_cash += openingCash;
        stats.store_breakdown[storeType].total_closing_cash += closingCash;
        stats.store_breakdown[storeType].total_calculated_cash += calculatedCash;
        stats.store_breakdown[storeType].total_cash_difference += cashDifference;
        stats.store_breakdown[storeType].total_cash_sales += cashSales;

        // Count days
        stats.days_opened++;
        stats.store_breakdown[storeType].days_opened++;

        if (register.closing_cash !== null) {
            stats.days_closed++;
            stats.store_breakdown[storeType].days_closed++;

            if (cashDifference === 0) {
                stats.perfect_matches++;
            } else {
                stats.variances++;
            }
        }
    });

    // Calculate averages
    stats.average_opening_cash = stats.days_opened > 0 ? stats.total_opening_cash / stats.days_opened : 0;
    stats.average_cash_difference = stats.days_closed > 0 ? stats.total_cash_difference / stats.days_closed : 0;

    return stats;
}