
const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/expenses
// @desc    Create a new expense
// @access  Private (Staff, Manager, Admin)
router.post('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            amount,
            description
        } = req.body;

        const user_id = req.user.user_id;
        const expense_date = new Date().toISOString().split('T')[0];

        // Validate required fields
        if (!store_id || !amount || !description) {
            return res.status(400).json({
                success: false,
                message: 'Store ID, amount, and description are required'
            });
        }

        if (parseFloat(amount) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be greater than 0'
            });
        }

        // Create expense
        const result = await db.query(
            `INSERT INTO expenses (
        store_id, user_id, expense_date, amount, description
      ) VALUES (?, ?, ?, ?, ?)`,
            [store_id, user_id, expense_date, amount, description]
        );

        // Get store info
        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Expense recorded successfully',
            expense_id: result.insertId,
            expense_data: {
                store_id,
                store_name: stores[0]?.store_name,
                expense_date,
                amount: parseFloat(amount),
                description
            }
        });
    } catch (error) {
        console.error('Create expense error:', error);
        res.status(500).json({
            success: false,
            message: 'Error recording expense'
        });
    }
});

// @route   GET /api/expenses
// @desc    Get expenses with filters
// @access  Private (Staff, Manager, Admin)
router.get('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            start_date,
            end_date,
            page = 1,
            limit = 50
        } = req.query;

        const user = req.user;
        const offset = (page - 1) * limit;

        let query = `
      SELECT 
        e.*,
        s.store_name,
        u.full_name as recorded_by
      FROM expenses e
      JOIN stores s ON e.store_id = s.store_id
      JOIN users u ON e.user_id = u.user_id
      WHERE 1=1
    `;

        const params = [];

        if (store_id) {
            query += ' AND e.store_id = ?';
            params.push(store_id);
        }

        // If user is staff, only show their store's expenses
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND e.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        if (start_date) {
            query += ' AND e.expense_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND e.expense_date <= ?';
            params.push(end_date);
        }

        query += ' ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const expenses = await db.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM expenses e WHERE 1=1';
        const countParams = params.slice(0, -2);

        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );
            if (stores.length > 0) {
                countQuery += ' AND e.store_id IN (?)';
                countParams.push(stores.map(s => s.store_id));
            }
        }

        const [countResult] = await db.query(countQuery, countParams);
        const total = countResult[0]?.total || 0;

        // Get total amount
        let sumQuery = 'SELECT COALESCE(SUM(amount), 0) as total_amount FROM expenses e WHERE 1=1';
        const sumParams = countParams;

        if (store_id) sumQuery += ' AND e.store_id = ?';
        if (start_date) sumQuery += ' AND e.expense_date >= ?';
        if (end_date) sumQuery += ' AND e.expense_date <= ?';

        const [sumResult] = await db.query(sumQuery, sumParams);
        const total_amount = parseFloat(sumResult[0]?.total_amount || 0);

        res.json({
            success: true,
            data: expenses,
            summary: {
                total_amount,
                total_count: total
            },
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get expenses error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching expenses'
        });
    }
});

// @route   GET /api/expenses/today
// @desc    Get today's expenses
// @access  Private (Staff, Manager, Admin)
router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user = req.user;
        const today = new Date().toISOString().split('T')[0];

        let query = `
      SELECT 
        e.*,
        s.store_name,
        u.full_name as recorded_by
      FROM expenses e
      JOIN stores s ON e.store_id = s.store_id
      JOIN users u ON e.user_id = u.user_id
      WHERE e.expense_date = ?
    `;

        const params = [today];

        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND e.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        query += ' ORDER BY s.store_name, e.created_at DESC';

        const expenses = await db.query(query, params);

        // Calculate totals
        const totals = expenses.reduce((acc, expense) => ({
            total_amount: acc.total_amount + parseFloat(expense.amount),
            count: acc.count + 1
        }), {
            total_amount: 0,
            count: 0
        });

        res.json({
            success: true,
            date: today,
            expenses,
            totals
        });
    } catch (error) {
        console.error('Get today expenses error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching today expenses'
        });
    }
});

// @route   GET /api/expenses/:id
// @desc    Get single expense by ID
// @access  Private (Staff, Manager, Admin)
router.get('/:id', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const [expenses] = await db.query(
            `SELECT 
        e.*,
        s.store_name,
        s.store_type,
        u.full_name as recorded_by
      FROM expenses e
      JOIN stores s ON e.store_id = s.store_id
      JOIN users u ON e.user_id = u.user_id
      WHERE e.expense_id = ?`,
            [id]
        );

        if (expenses.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Expense not found'
            });
        }

        res.json({
            success: true,
            data: expenses[0]
        });
    } catch (error) {
        console.error('Get expense error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching expense'
        });
    }
});

// @route   DELETE /api/expenses/:id
// @desc    Delete an expense
// @access  Private (Manager, Admin only)
router.delete('/:id', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        // Check if expense exists
        const [expenses] = await db.query(
            'SELECT * FROM expenses WHERE expense_id = ?',
            [id]
        );

        if (expenses.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Expense not found'
            });
        }

        // Delete expense
        await db.query('DELETE FROM expenses WHERE expense_id = ?', [id]);

        res.json({
            success: true,
            message: 'Expense deleted successfully'
        });
    } catch (error) {
        console.error('Delete expense error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting expense'
        });
    }
});

module.exports = router;