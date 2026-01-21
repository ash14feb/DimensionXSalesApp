const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/sales
// @desc    Create a new sale
// @access  Private (Staff, Manager, Admin)
router.post('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            cash_amount = 0,
            upi_amount = 0,
            card_amount = 0,
            booking_amount = 0,
            product_description = null,
            total_customers = 1,
            notes = null
        } = req.body;

        const user_id = req.user.user_id;

        // Validate required fields
        if (!store_id) {
            return res.status(400).json({
                success: false,
                message: 'Store ID is required'
            });
        }

        // Calculate total amount
        const total_amount = parseFloat(cash_amount) + parseFloat(upi_amount) +
            parseFloat(card_amount) + parseFloat(booking_amount);

        // Get current date and time
        const sale_date = new Date().toISOString().split('T')[0];
        const sale_time = new Date().toTimeString().split(' ')[0];
        const sale_datetime = new Date();

        // Insert sale
        const result = await db.query(
            `INSERT INTO sales (
        store_id, user_id, sale_date, sale_time, sale_datetime,
        cash_amount, upi_amount, card_amount, booking_amount,
        product_description, total_customers, total_amount, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                store_id, user_id, sale_date, sale_time, sale_datetime,
                cash_amount, upi_amount, card_amount, booking_amount,
                product_description, total_customers, total_amount, notes
            ]
        );

        // Get store info for response
        const [stores] = await db.query(
            'SELECT store_name, store_type FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Sale recorded successfully',
            sale_id: result.insertId,
            sale_data: {
                store_id,
                store_name: stores[0]?.store_name,
                store_type: stores[0]?.store_type,
                sale_date,
                sale_time,
                cash_amount,
                upi_amount,
                card_amount,
                booking_amount,
                total_amount,
                total_customers,
                product_description
            }
        });
    } catch (error) {
        console.error('Create sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error recording sale'
        });
    }
});

// @route   GET /api/sales
// @desc    Get sales with filters
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

        // Base query
        let query = `
      SELECT 
        s.sale_id,
        s.store_id,
        st.store_name,
        st.store_type,
        s.sale_date,
        s.sale_time,
        s.cash_amount,
        s.upi_amount,
        s.card_amount,
        s.booking_amount,
        s.product_description,
        s.total_customers,
        s.total_amount,
        s.notes,
        u.full_name as staff_name,
        s.created_at
      FROM sales s
      JOIN stores st ON s.store_id = st.store_id
      JOIN users u ON s.user_id = u.user_id
      WHERE 1=1
    `;

        const params = [];

        // Apply filters
        if (store_id) {
            query += ' AND s.store_id = ?';
            params.push(store_id);
        }

        // If user is staff, only show their store's sales
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND s.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        // Date filters
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date);
        }

        // Order and pagination
        query += ' ORDER BY s.sale_date DESC, s.sale_time DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        // Execute query
        const sales = await db.query(query, params);

        // Get total count for pagination
        let countQuery = 'SELECT COUNT(*) as total FROM sales s WHERE 1=1';
        const countParams = params.slice(0, -2); // Remove limit and offset

        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );
            if (stores.length > 0) {
                countQuery += ' AND s.store_id IN (?)';
                countParams.push(stores.map(s => s.store_id));
            }
        }

        const [countResult] = await db.query(countQuery, countParams);
        const total = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: sales,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sales'
        });
    }
});

// @route   GET /api/sales/today
// @desc    Get today's sales summary
// @access  Private (Staff, Manager, Admin)
router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user = req.user;
        const today = new Date().toISOString().split('T')[0];

        let query = `
      SELECT 
        st.store_id,
        st.store_name,
        st.store_type,
        COUNT(s.sale_id) as total_transactions,
        SUM(s.cash_amount) as total_cash,
        SUM(s.upi_amount) as total_upi,
        SUM(s.card_amount) as total_card,
        SUM(s.booking_amount) as total_booking,
        SUM(s.total_amount) as total_sales,
        SUM(s.total_customers) as total_customers
      FROM stores st
      LEFT JOIN sales s ON st.store_id = s.store_id AND s.sale_date = ?
    `;

        const params = [today];

        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            query += ' WHERE st.store_type = ?';
            params.push(user.assigned_store);
        }

        query += ' GROUP BY st.store_id, st.store_name, st.store_type ORDER BY st.store_name';

        const salesSummary = await db.query(query, params);

        // Get overall totals
        const totals = salesSummary.reduce((acc, store) => ({
            total_cash: acc.total_cash + (store.total_cash || 0),
            total_upi: acc.total_upi + (store.total_upi || 0),
            total_card: acc.total_card + (store.total_card || 0),
            total_booking: acc.total_booking + (store.total_booking || 0),
            total_sales: acc.total_sales + (store.total_sales || 0),
            total_customers: acc.total_customers + (store.total_customers || 0),
            total_transactions: acc.total_transactions + (store.total_transactions || 0)
        }), {
            total_cash: 0,
            total_upi: 0,
            total_card: 0,
            total_booking: 0,
            total_sales: 0,
            total_customers: 0,
            total_transactions: 0
        });

        res.json({
            success: true,
            date: today,
            stores: salesSummary,
            totals
        });
    } catch (error) {
        console.error('Get today sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching today sales'
        });
    }
});

// @route   GET /api/sales/:id
// @desc    Get single sale by ID
// @access  Private (Staff, Manager, Admin)
router.get('/:id', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const [sales] = await db.query(
            `SELECT 
        s.*,
        st.store_name,
        st.store_type,
        u.full_name as staff_name
      FROM sales s
      JOIN stores st ON s.store_id = st.store_id
      JOIN users u ON s.user_id = u.user_id
      WHERE s.sale_id = ?`,
            [id]
        );

        if (sales.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Sale not found'
            });
        }

        res.json({
            success: true,
            data: sales[0]
        });
    } catch (error) {
        console.error('Get sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sale'
        });
    }
});

// @route   PUT /api/sales/:id
// @desc    Update a sale
// @access  Private (Manager, Admin only)
router.put('/:id', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            cash_amount,
            upi_amount,
            card_amount,
            booking_amount,
            product_description,
            total_customers,
            notes
        } = req.body;

        // Check if sale exists
        const [existingSales] = await db.query(
            'SELECT * FROM sales WHERE sale_id = ?',
            [id]
        );

        if (existingSales.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Sale not found'
            });
        }

        const existingSale = existingSales[0];

        // Use existing values if not provided
        const updatedCash = cash_amount !== undefined ? cash_amount : existingSale.cash_amount;
        const updatedUpi = upi_amount !== undefined ? upi_amount : existingSale.upi_amount;
        const updatedCard = card_amount !== undefined ? card_amount : existingSale.card_amount;
        const updatedBooking = booking_amount !== undefined ? booking_amount : existingSale.booking_amount;
        const updatedProductDesc = product_description !== undefined ? product_description : existingSale.product_description;
        const updatedCustomers = total_customers !== undefined ? total_customers : existingSale.total_customers;
        const updatedNotes = notes !== undefined ? notes : existingSale.notes;

        // Calculate new total
        const total_amount = parseFloat(updatedCash) + parseFloat(updatedUpi) +
            parseFloat(updatedCard) + parseFloat(updatedBooking);

        // Update sale
        await db.query(
            `UPDATE sales SET
        cash_amount = ?,
        upi_amount = ?,
        card_amount = ?,
        booking_amount = ?,
        product_description = ?,
        total_customers = ?,
        total_amount = ?,
        notes = ?
      WHERE sale_id = ?`,
            [
                updatedCash, updatedUpi, updatedCard, updatedBooking,
                updatedProductDesc, updatedCustomers, total_amount, updatedNotes, id
            ]
        );

        res.json({
            success: true,
            message: 'Sale updated successfully'
        });
    } catch (error) {
        console.error('Update sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating sale'
        });
    }
});

module.exports = router;