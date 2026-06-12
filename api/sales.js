







const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/sales
// @desc    Create a new sale
// @access  Private (Staff, Manager, Admin)
// @route   POST /api/sales
// @desc    Create or Update daily sale per store
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
            notes = null,
            sale_date,
            sale_time,
            sale_datetime
        } = req.body;

        const user_id = req.user.user_id;

        if (!store_id || !sale_date) {
            return res.status(400).json({
                success: false,
                message: 'store_id and sale_date are required'
            });
        }

        const total_amount =
            Number(cash_amount) +
            Number(upi_amount) +
            Number(card_amount) +
            Number(booking_amount);

        // 🔍 Check if sale already exists for store + date
        const existing = await db.query(
            `SELECT sale_id FROM sales 
             WHERE store_id = ? AND sale_date = ?`,
            [store_id, sale_date]
        );

        // 🔁 UPDATE existing record
        if (existing.length > 0) {
            const saleId = existing[0].sale_id;

            await db.query(
                `UPDATE sales SET
                    cash_amount =  ?,
                    upi_amount =  ?,
                    card_amount =  ?,
                    booking_amount =  ?,
                    total_customers =  ?,
                    total_amount =  ?,
                    notes = COALESCE(?, notes)
                 WHERE sale_id = ?`,
                [
                    cash_amount,
                    upi_amount,
                    card_amount,
                    booking_amount,
                    total_customers,
                    total_amount,
                    notes,
                    saleId
                ]
            );

            return res.json({
                success: true,
                message: 'Sale updated for the day',
                sale_id: saleId
            });
        }

        // ➕ INSERT new record
        const result = await db.query(
            `INSERT INTO sales (
                store_id,
                user_id,
                sale_date,
                sale_time,
                sale_datetime,
                cash_amount,
                upi_amount,
                card_amount,
                booking_amount,
                product_description,
                total_customers,
                total_amount,
                notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                store_id,
                user_id,
                sale_date,
                sale_time,
                sale_datetime,
                cash_amount,
                upi_amount,
                card_amount,
                booking_amount,
                product_description,
                total_customers,
                total_amount,
                notes
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Sale created for the day',
            sale_id: result.insertId
        });

    } catch (error) {
        console.error('Create/Update sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving sale'
        });
    }
});


// @route   GET /api/sales/day
// @desc    Get sales data for a specific day
// @access  Private (Staff, Manager, Admin)
router.get('/day', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'date is required in YYYY-MM-DD format'
            });
        }

        const user = req.user;

        let query = `
            SELECT
                s.sale_id,
                DATE(s.sale_date) AS sale_date,
                s.sale_time,
                s.store_id,
                st.store_name,
                st.store_type,
                s.cash_amount,
                s.upi_amount,
                s.card_amount,
                s.booking_amount,
                s.total_amount,
                s.total_customers,
                s.product_description,
                s.notes,
                u.full_name AS staff_name,
                s.created_at
            FROM sales s
            INNER JOIN stores st ON s.store_id = st.store_id
            INNER JOIN users u ON s.user_id = u.user_id
            WHERE DATE(s.sale_date) = ?
        `;

        const params = [date];

        // 🔐 Restrict staff to their store only
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const stores = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length === 0) {
                return res.json({
                    success: true,
                    date,
                    count: 0,
                    data: []
                });
            }

            const storeIds = stores.map(s => s.store_id);
            query += ` AND s.store_id IN (${storeIds.map(() => '?').join(',')})`;
            params.push(...storeIds);
        }

        query += ' ORDER BY st.store_id ASC, s.sale_time ASC';

        const rows = await db.query(query, params);

        res.json({
            success: true,
            date,
            count: rows.length,
            data: rows
        });

    } catch (error) {
        console.error('Get daily sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching daily sales'
        });
    }
});

router.get('/monthly', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'date is required (YYYY-MM-DD)'
            });
        }

        const query = `
        WITH RECURSIVE calendar AS (
            SELECT DATE_FORMAT(?, '%Y-%m-01') AS sale_date
            UNION ALL
            SELECT DATE_ADD(sale_date, INTERVAL 1 DAY)
            FROM calendar
            WHERE sale_date < LAST_DAY(?)
        )
        SELECT 
            c.sale_date,

            /* ARCADE (1) */
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.cash_amount END), 0) AS arcade_cash,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.upi_amount END), 0) AS arcade_upi,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.card_amount END), 0) AS arcade_card,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.total_amount END), 0) AS arcade_total_sales,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.total_customers END), 0) AS arcade_customers,

            /* DREAMCUBE (2) */
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.cash_amount END), 0) AS dreamcube_cash,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.upi_amount END), 0) AS dreamcube_upi,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.card_amount END), 0) AS dreamcube_card,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.total_amount END), 0) AS dreamcube_total_sales,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.total_customers END), 0) AS dreamcube_customers,

            /* TOYS (4) */
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.cash_amount END), 0) AS toys_cash,
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.upi_amount END), 0) AS toys_upi,
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.card_amount END), 0) AS toys_card,
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.total_amount END), 0) AS toys_total_sales,

            /* BOOKING (3) */
            COALESCE(SUM(CASE WHEN s.store_id = 3 THEN s.booking_amount END), 0) AS booking_total_amount,

            /* FINAL TOTALS */
            COALESCE(SUM(s.cash_amount), 0) AS total_cash,
            COALESCE(SUM(s.upi_amount + s.card_amount), 0) AS total_upi_card,
            COALESCE(SUM(s.total_amount + s.booking_amount), 0) AS grand_total_sales

        FROM calendar c
        LEFT JOIN sales s 
            ON s.sale_date = c.sale_date
        GROUP BY c.sale_date
        ORDER BY c.sale_date;
        `;

        const rows = await db.query(query, [date, date]);

        res.json({
            success: true,
            month: date.substring(0, 7),
            days: rows   // ← THIS WILL NOW BE AN ARRAY (31 days)
        });

    } catch (error) {
        console.error('Monthly sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching monthly sales'
        });
    }
});

// @route   GET /api/sales
// @desc    Get sales with filters
// @access  Private (Staff, Manager, Admin)
router.get('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, start_date, end_date } = req.query;
        const user = req.user;

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
            u.full_name AS staff_name,
            s.created_at
        FROM sales s
        JOIN stores st ON s.store_id = st.store_id
        JOIN users u ON s.user_id = u.user_id
        WHERE 1=1
        `;

        const params = [];

        // 🔹 Filter by store_id (query param)
        if (store_id) {
            query += ' AND s.store_id = ?';
            params.push(Number(store_id));
        }

        // 🔹 Staff restriction (important)
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const stores = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                const storeIds = stores.map(s => s.store_id);
                query += ` AND s.store_id IN (${storeIds.map(() => '?').join(',')})`;
                params.push(...storeIds);
            } else {
                // Staff has no stores → return empty result safely
                return res.json({ success: true, data: [] });
            }
        }

        // 🔹 Date filters
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date);
        }

        // 🔹 Ordering
        query += ' ORDER BY s.sale_date DESC, s.sale_time DESC';

        // 🧪 Optional debug
        // console.log(query);
        // console.log(params);

        const sales = await db.query(query, params);

        res.json({
            success: true,
            count: sales.length,
            data: sales
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
        console.log(today);
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

        const sales = await db.query(
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


// @route   GET /api/sales/monthly
// @desc    Get monthly day-wise consolidated sales
// @access  Private



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


//ActualSales
router.post(
    '/actual-sales',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const {
                sales_date,
                cash = 0,
                card = 0,
                upi_bank = 0,
                upi_paytm = 0
            } = req.body;

            if (!sales_date) {
                return res.status(400).json({
                    success: false,
                    message: 'sales_date is required'
                });
            }

            await db.query(
                `
                INSERT INTO actual_sales (
                    sales_date,
                    cash,
                    card,
                    upi_bank,
                    upi_paytm
                )
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    cash = VALUES(cash),
                    card = VALUES(card),
                    upi_bank = VALUES(upi_bank),
                    upi_paytm = VALUES(upi_paytm),
                    updated_at = CURRENT_TIMESTAMP
                `,
                [
                    sales_date,
                    cash,
                    card,
                    upi_bank,
                    upi_paytm
                ]
            );

            res.json({
                success: true,
                message: 'Actual sales saved successfully'
            });

        } catch (error) {
            console.error('Save actual sales error:', error);

            res.status(500).json({
                success: false,
                message: 'Error saving actual sales'
            });
        }
    }
);


router.put(
    '/actual-sales',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const {
                sales_date,
                cash,
                card,
                upi_bank,
                upi_paytm
            } = req.body;

            const existing = await db.query(
                'SELECT id FROM actual_sales WHERE sales_date = ?',
                [sales_date]
            );

            if (existing.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Actual sales record not found'
                });
            }

            await db.query(
                `UPDATE actual_sales
                 SET cash = ?,
                     card = ?,
                     upi_bank = ?,
                     upi_paytm = ?
                 WHERE sales_date = ?`,
                [
                    cash,
                    card,
                    upi_bank,
                    upi_paytm,
                    sales_date
                ]
            );

            res.json({
                success: true,
                message: 'Actual sales updated successfully'
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: 'Error updating actual sales'
            });
        }
    }
);


router.get(
    '/actual-sales/month',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { year, month } = req.query;

            if (!year || !month) {
                return res.status(400).json({
                    success: false,
                    message: 'year and month are required'
                });
            }

            const result = await db.query(
                `
                SELECT
                    id,
                    sales_date,
                    cash,
                    card,
                    upi_bank,
                    upi_paytm,
                    (cash + card + upi_bank + upi_paytm) AS total_sales,
                    created_at,
                    updated_at
                FROM actual_sales
                WHERE YEAR(sales_date) = ?
                  AND MONTH(sales_date) = ?
                ORDER BY sales_date DESC
                `,
                [year, month]
            );

            res.json({
                success: true,
                data: result
            });

        } catch (error) {
            console.error('Get actual sales by month error:', error);

            res.status(500).json({
                success: false,
                message: 'Error fetching actual sales'
            });
        }
    }
);

router.get(
    '/actual-sales/:sales_date',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { sales_date } = req.params;

            const result = await db.query(
                'SELECT * FROM actual_sales WHERE sales_date = ?',
                [sales_date]
            );

            res.json({
                success: true,
                data: result.length ? result[0] : null
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: 'Error fetching actual sales'
            });
        }
    }
);



router.get(
    '/actual-sales/month-summary',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { year, month } = req.query;

            const result = await db.query(
                `
                SELECT
                    COALESCE(SUM(cash), 0) AS cash,
                    COALESCE(SUM(card), 0) AS card,
                    COALESCE(SUM(upi_bank), 0) AS upi_bank,
                    COALESCE(SUM(upi_paytm), 0) AS upi_paytm,
                    COALESCE(SUM(cash + card + upi_bank + upi_paytm), 0) AS total_sales
                FROM actual_sales
                WHERE YEAR(sales_date) = ?
                  AND MONTH(sales_date) = ?
                `,
                [year, month]
            );

            res.json({
                success: true,
                data: result[0]
            });

        } catch (error) {
            console.error('Get actual sales summary error:', error);

            res.status(500).json({
                success: false,
                message: 'Error fetching summary'
            });
        }
    }
);


router.post(
    '/sales-by-staff',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const {
                user_id,
                sales_date,
                saleamount_arcade = 0,
                saleamount_dreamcube = 0,
                saleamount_space = 0,
                saleamount_3k_vip = 0,
                saleamount_5k_vip = 0
            } = req.body;

            if (!user_id || !sales_date) {
                return res.status(400).json({
                    success: false,
                    message: 'user_id and sales_date are required'
                });
            }

            await db.query(
                `
                INSERT INTO sales_by_staff (
                    user_id,
                    sales_date,
                    saleamount_arcade,
                    saleamount_dreamcube,
                    saleamount_space,
                    saleamount_3k_vip,
                    saleamount_5k_vip
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    saleamount_arcade = VALUES(saleamount_arcade),
                    saleamount_dreamcube = VALUES(saleamount_dreamcube),
                    saleamount_space = VALUES(saleamount_space),
                    saleamount_3k_vip = VALUES(saleamount_3k_vip),
                    saleamount_5k_vip = VALUES(saleamount_5k_vip),
                    updated_at = CURRENT_TIMESTAMP
                `,
                [
                    user_id,
                    sales_date,
                    saleamount_arcade,
                    saleamount_dreamcube,
                    saleamount_space,
                    saleamount_3k_vip,
                    saleamount_5k_vip
                ]
            );

            res.json({
                success: true,
                message: 'Sales by staff saved successfully'
            });

        } catch (error) {
            console.error('Save sales by staff error:', error);

            res.status(500).json({
                success: false,
                message: 'Error saving sales by staff'
            });
        }
    }
);

router.get(
    '/sales-by-staff/month-summary',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { year, month } = req.query;

            if (!year || !month) {
                return res.status(400).json({
                    success: false,
                    message: 'year and month are required'
                });
            }

            const result = await db.query(
                `
                SELECT
                    s.user_id,
                    u.full_name AS staff_name,

                    SUM(s.saleamount_arcade) AS total_arcade_sales,
                    SUM(s.saleamount_dreamcube) AS total_dreamcube_sales,
                    SUM(s.saleamount_space) AS total_space_sales,

                    SUM(s.saleamount_3k_vip) AS total_3k_vip_cards,
                    SUM(s.saleamount_5k_vip) AS total_5k_vip_cards,

                    SUM(
                        s.saleamount_arcade +
                        s.saleamount_dreamcube +
                        s.saleamount_space
                    ) AS total_sales_amount

                FROM sales_by_staff s
                LEFT JOIN users u ON u.user_id = s.user_id

                WHERE YEAR(s.sales_date) = ?
                  AND MONTH(s.sales_date) = ?

                GROUP BY s.user_id, u.full_name

                ORDER BY total_sales_amount DESC
                `,
                [year, month]
            );

            res.json({
                success: true,
                data: result
            });

        } catch (error) {
            console.error('Get monthly staff summary error:', error);

            res.status(500).json({
                success: false,
                message: 'Error fetching monthly staff summary'
            });
        }
    }
);
router.get(
    '/sales-by-staff/:sales_date',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { sales_date } = req.params;

            const result = await db.query(
                `
                SELECT
                    s.*,
                    u.full_name AS staff_name,
                    (
                        saleamount_arcade +
                        saleamount_dreamcube +
                        saleamount_space +
                        saleamount_3k_vip +
                        saleamount_5k_vip
                    ) AS total_sales
                FROM sales_by_staff s
                LEFT JOIN users u ON u.user_id = s.user_id
                WHERE s.sales_date = ?
                ORDER BY u.full_name
                `,
                [sales_date]
            );

            res.json({
                success: true,
                data: result
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: 'Error fetching sales by staff'
            });
        }
    }
);







router.post(
    '/admin-cash-taken',
    authorize('manager', 'admin'),
    async (req, res) => {
        try {
            const {
                cash_date,
                amount = 0,
                cash_taken_by
            } = req.body;

            if (!cash_date) {
                return res.status(400).json({
                    success: false,
                    message: 'cash_date is required'
                });
            }

            await db.query(
                `
                INSERT INTO admin_cash_taken
                (
                    cash_date,
                    amount,
                    cash_taken_by
                )
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    amount = VALUES(amount),
                    cash_taken_by = VALUES(cash_taken_by),
                    updated_at = CURRENT_TIMESTAMP
                `,
                [
                    cash_date,
                    amount,
                    cash_taken_by || ''
                ]
            );

            res.json({
                success: true,
                message: 'Admin cash taken saved successfully'
            });

        } catch (error) {
            console.error('Save admin cash taken error:', error);

            res.status(500).json({
                success: false,
                message: 'Error saving admin cash taken'
            });
        }
    }
);

router.get(
    '/admin-cash-taken/month',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { year, month } = req.query;

            if (!year || !month) {
                return res.status(400).json({
                    success: false,
                    message: 'year and month are required'
                });
            }

            const result = await db.query(
                `
                SELECT
                    id,
                    cash_date,
                    amount,
                    cash_taken_by,
                    created_at,
                    updated_at
                FROM admin_cash_taken
                WHERE YEAR(cash_date) = ?
                  AND MONTH(cash_date) = ?
                ORDER BY cash_date DESC
                `,
                [year, month]
            );

            res.json({
                success: true,
                data: result
            });

        } catch (error) {
            console.error('Get admin cash taken month error:', error);

            res.status(500).json({
                success: false,
                message: 'Error fetching admin cash taken records'
            });
        }
    }
);

router.get(
    '/admin-cash-taken/:cash_date',
    authorize('staff', 'manager', 'admin'),
    async (req, res) => {
        try {
            const { cash_date } = req.params;

            const result = await db.query(
                `
                SELECT *
                FROM admin_cash_taken
                WHERE cash_date = ?
                `,
                [cash_date]
            );

            res.json({
                success: true,
                data: result.length ? result[0] : null
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: 'Error fetching admin cash taken'
            });
        }
    }
);



module.exports = router;


