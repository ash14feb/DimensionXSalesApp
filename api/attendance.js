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
        const { store_id, latitude, longitude, login_time } = req.body;
        const user_id = req.user.user_id;

        // Check if user is already clocked in today
        const today = login_time.split('T')[0];
        const existingAttendance = await db.query(
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
        user_id, store_id, login_latitude, login_longitude,login_time
      ) VALUES (?, ?, ?, ?,?)`,
            [user_id, store_id, latitude, longitude, login_time]
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
            login_time: login_time
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
        const { latitude, longitude, date, logout_time } = req.body;
        const user_id = req.user.user_id;
        const today = date;

        // Find today's active attendance
        const attendance = await db.query(
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
        const logoutTime = logout_time;

        // Calculate work duration in minutes
        const workDurationMinutes = Math.round((logoutTime - loginTime) / (1000 * 60));

        // Update attendance with clock out        work_duration_minutes = ?
        await db.query(
            `UPDATE staff_attendance SET
        logout_time = ?,
        logout_latitude = ?,
        logout_longitude = ?
        WHERE attendance_id = ?`,
            [logoutTime, latitude, longitude, attendanceRecord.attendance_id]
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

// @route   GET /api/attendance/status
// @desc    Get attendance status for a specific date (defaults to today)
// @access  Private (Staff, Manager, Admin)
router.get('/status', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user_id = req.user.user_id;

        // Get date from query parameter, default to today
        let date = req.query.date;

        if (!date) {
            // Default to today if no date provided
            return res.status(400).json({
                success: false,
                message: 'Invalid date'
            });
        } else {
            // Validate date format (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid date format. Please use YYYY-MM-DD'
                });
            }

            // Additional validation to ensure it's a valid date
            const parsedDate = new Date(date);
            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid date provided'
                });
            }
        }

        const attendance = await db.query(
            `SELECT
        a.*,
        s.store_name,
        u.full_name,
        DATE_FORMAT(a.login_time, '%Y-%m-%d %H:%i:%s') as login_time_local,
        DATE_FORMAT(a.logout_time, '%Y-%m-%d %H:%i:%s') as logout_time_local,
        DATE_FORMAT(a.attendance_date, '%Y-%m-%d') as attendance_date_local
      FROM staff_attendance a
      JOIN stores s ON a.store_id = s.store_id
      JOIN users u ON a.user_id = u.user_id
      WHERE a.user_id = ? AND a.attendance_date = ?`,
            [user_id, date]
        );

        res.json({
            success: true,
            date: date,
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
            end_date
        } = req.query;

        let query = `
      SELECT 
        a.*,
        s.store_name,
        u.full_name,
        u.username,
        DATE_FORMAT(a.login_time, '%Y-%m-%d %H:%i:%s') as login_time_formatted,
        DATE_FORMAT(a.logout_time, '%Y-%m-%d %H:%i:%s') as logout_time_formatted,
        DATE_FORMAT(a.attendance_date, '%Y-%m-%d') as attendance_date_formatted
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

        query += ' ORDER BY a.attendance_date DESC, a.login_time DESC';

        const attendance = await db.query(query, params);

        // Format the response data
        const formattedData = attendance.map(record => ({
            attendance_id: record.attendance_id,
            user_id: record.user_id,
            store_id: record.store_id,
            login_time: record.login_time_formatted || record.login_time,
            logout_time: record.logout_time_formatted || record.logout_time,
            login_latitude: record.login_latitude,
            login_longitude: record.login_longitude,
            logout_latitude: record.logout_latitude,
            logout_longitude: record.logout_longitude,
            work_duration_minutes: record.work_duration_minutes,
            attendance_date: record.attendance_date_formatted || record.attendance_date,
            store_name: record.store_name,
            full_name: record.full_name,
            username: record.username
        }));

        res.json({
            success: true,
            data: formattedData,
            count: formattedData.length
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