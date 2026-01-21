const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/attendance/clock-in
// @desc    Clock in for attendance
// @access  Private (Staff, Manager, Admin)
router.post('/clock-in', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, latitude, longitude } = req.body;
        const user_id = req.user.user_id;

        // Check if user is already clocked in today
        const today = new Date().toISOString().split('T')[0];
        const [existingAttendance] = await db.query(
            'SELECT * FROM staff_attendance WHERE user_id = ? AND attendance_date = ? AND logout_time IS NULL',
            [user_id, today]
        );

        if (existingAttendance.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'You are already clocked in for today'
            });
        }

        // Clock in
        const result = await db.query(
            `INSERT INTO staff_attendance (
        user_id, store_id, login_latitude, login_longitude
      ) VALUES (?, ?, ?, ?)`,
            [user_id, store_id, latitude, longitude]
        );

        // Get store info
        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Clocked in successfully',
            attendance_id: result.insertId,
            store_name: stores[0]?.store_name,
            login_time: new Date()
        });
    } catch (error) {
        console.error('Clock in error:', error);
        res.status(500).json({
            success: false,
            message: 'Error clocking in'
        });
    }
});

// @route   POST /api/attendance/clock-out
// @desc    Clock out for attendance
// @access  Private (Staff, Manager, Admin)
router.post('/clock-out', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        const user_id = req.user.user_id;
        const today = new Date().toISOString().split('T')[0];

        // Find today's active attendance
        const [attendance] = await db.query(
            'SELECT * FROM staff_attendance WHERE user_id = ? AND attendance_date = ? AND logout_time IS NULL',
            [user_id, today]
        );

        if (attendance.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No active attendance found for today'
            });
        }

        const attendanceRecord = attendance[0];
        const loginTime = new Date(attendanceRecord.login_time);
        const logoutTime = new Date();

        // Calculate work duration in minutes
        const workDurationMinutes = Math.round((logoutTime - loginTime) / (1000 * 60));

        // Update attendance with clock out
        await db.query(
            `UPDATE staff_attendance SET
        logout_time = ?,
        logout_latitude = ?,
        logout_longitude = ?,
        work_duration_minutes = ?
      WHERE attendance_id = ?`,
            [logoutTime, latitude, longitude, workDurationMinutes, attendanceRecord.attendance_id]
        );

        res.json({
            success: true,
            message: 'Clocked out successfully',
            login_time: loginTime,
            logout_time: logoutTime,
            work_duration_minutes: workDurationMinutes,
            work_duration_hours: (workDurationMinutes / 60).toFixed(2)
        });
    } catch (error) {
        console.error('Clock out error:', error);
        res.status(500).json({
            success: false,
            message: 'Error clocking out'
        });
    }
});

// @route   GET /api/attendance/today
// @desc    Get today's attendance status
// @access  Private (Staff, Manager, Admin)
router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const today = new Date().toISOString().split('T')[0];

        const [attendance] = await db.query(
            `SELECT 
        a.*,
        s.store_name,
        u.full_name
      FROM staff_attendance a
      JOIN stores s ON a.store_id = s.store_id
      JOIN users u ON a.user_id = u.user_id
      WHERE a.user_id = ? AND a.attendance_date = ?`,
            [user_id, today]
        );

        res.json({
            success: true,
            date: today,
            attendance: attendance.length > 0 ? attendance[0] : null,
            status: attendance.length > 0
                ? (attendance[0].logout_time ? 'clocked_out' : 'clocked_in')
                : 'not_clocked_in'
        });
    } catch (error) {
        console.error('Get attendance error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching attendance'
        });
    }
});

// @route   GET /api/attendance
// @desc    Get attendance records with filters
// @access  Private (Manager, Admin)
router.get('/', authorize('manager', 'admin'), async (req, res) => {
    try {
        const {
            user_id,
            store_id,
            start_date,
            end_date,
            page = 1,
            limit = 50
        } = req.query;

        const offset = (page - 1) * limit;

        let query = `
      SELECT 
        a.*,
        s.store_name,
        u.full_name,
        u.username
      FROM staff_attendance a
      JOIN stores s ON a.store_id = s.store_id
      JOIN users u ON a.user_id = u.user_id
      WHERE 1=1
    `;

        const params = [];

        if (user_id) {
            query += ' AND a.user_id = ?';
            params.push(user_id);
        }

        if (store_id) {
            query += ' AND a.store_id = ?';
            params.push(store_id);
        }

        if (start_date) {
            query += ' AND a.attendance_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND a.attendance_date <= ?';
            params.push(end_date);
        }

        query += ' ORDER BY a.attendance_date DESC, a.login_time DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const attendance = await db.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM staff_attendance a WHERE 1=1';
        const countParams = params.slice(0, -2);

        if (user_id) countQuery += ' AND a.user_id = ?';
        if (store_id) countQuery += ' AND a.store_id = ?';
        if (start_date) countQuery += ' AND a.attendance_date >= ?';
        if (end_date) countQuery += ' AND a.attendance_date <= ?';

        const [countResult] = await db.query(countQuery, countParams);
        const total = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: attendance,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get attendance records error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching attendance records'
        });
    }
});

module.exports = router;