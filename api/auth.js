const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validation
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        // Check if user exists - CHANGED: removed [] from db.query()
        const users = await db.query(
            'SELECT * FROM users WHERE username = ? AND is_active = 1',
            [username]
        );

        console.log('Users found:', users ? users.length : 0); // Debug log

        if (!users || users.length === 0) {
            console.log('No user found for username:', username);
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const user = users[0];
        console.log(user); // Debug log

        // Check password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials1'
            });
        }

        // Create token
        const token = jwt.sign(
            { userId: user.user_id, userType: user.user_type },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        // Remove password from response
        const { password_hash, ...userWithoutPassword } = user;

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: userWithoutPassword
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// @route   POST /api/auth/change-password
// @desc    Change password
// @access  Private
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.user_id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long'
            });
        }

        // Get user current password - CHANGED: removed []
        const users = await db.query(
            'SELECT password_hash FROM users WHERE user_id = ?',
            [userId]
        );

        if (!users || users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Verify current password
        const isPasswordValid = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password
        await db.query(
            'UPDATE users SET password_hash = ? WHERE user_id = ?',
            [hashedPassword, userId]
        );

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// @route   POST /api/auth/create-user
// @desc    Create new user (Admin only)
// @access  Private (Admin only)
router.post('/create-user', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const {
            username,
            password,
            full_name,
            user_type,
            assigned_store
        } = req.body;

        // Validation
        if (!username || !password || !full_name || !user_type || !assigned_store) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required: username, password, full_name, user_type, assigned_store'
            });
        }

        // Validate user_type
        const validUserTypes = ['admin', 'manager', 'staff'];
        if (!validUserTypes.includes(user_type)) {
            return res.status(400).json({
                success: false,
                message: 'user_type must be one of: admin, manager, staff'
            });
        }

        // Validate assigned_store
        const validStores = ['arcade', 'dreamcube', 'toys_merch', 'all'];
        if (!validStores.includes(assigned_store)) {
            return res.status(400).json({
                success: false,
                message: 'assigned_store must be one of: arcade, dreamcube, toys_merch, all'
            });
        }

        // Check if username already exists - CHANGED: removed []
        const existingUsers = await db.query(
            'SELECT user_id FROM users WHERE username = ?',
            [username]
        );

        if (existingUsers && existingUsers.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Username already exists'
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // Insert new user
        const result = await db.query(
            `INSERT INTO users (
                username, 
                password_hash, 
                full_name, 
                user_type, 
                assigned_store
            ) VALUES (?, ?, ?, ?, ?)`,
            [username, password_hash, full_name, user_type, assigned_store]
        );

        // Get the created user (excluding password) - CHANGED: removed []
        const newUser = await db.query(
            `SELECT 
                user_id,
                username,
                full_name,
                user_type,
                assigned_store,
                is_active,
                created_at
            FROM users 
            WHERE user_id = ?`,
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            message: 'User created successfully',
            user: newUser[0]
        });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating user'
        });
    }
});

// @route   GET /api/auth/users
// @desc    Get all users (Admin only)
// @access  Private (Admin only)
router.get('/users', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        // CHANGED: removed []
        const users = await db.query(
            `SELECT 
                user_id,
                username,
                full_name,
                user_type,
                assigned_store,
                is_active,
                created_at
            FROM users 
            ORDER BY created_at DESC`
        );

        res.json({
            success: true,
            users
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching users'
        });
    }
});

// @route   PUT /api/auth/users/:id
// @desc    Update user (Admin only)
// @access  Private (Admin only)
router.put('/users/:id', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            full_name,
            user_type,
            assigned_store,
            is_active
        } = req.body;

        // Check if user exists - CHANGED: removed []
        const existingUsers = await db.query(
            'SELECT * FROM users WHERE user_id = ?',
            [id]
        );

        if (!existingUsers || existingUsers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Build update query dynamically
        const updates = [];
        const values = [];

        if (full_name !== undefined) {
            updates.push('full_name = ?');
            values.push(full_name);
        }

        if (user_type !== undefined) {
            const validUserTypes = ['admin', 'manager', 'staff'];
            if (!validUserTypes.includes(user_type)) {
                return res.status(400).json({
                    success: false,
                    message: 'user_type must be one of: admin, manager, staff'
                });
            }
            updates.push('user_type = ?');
            values.push(user_type);
        }

        if (assigned_store !== undefined) {
            const validStores = ['arcade', 'dreamcube', 'toys_merch', 'all'];
            if (!validStores.includes(assigned_store)) {
                return res.status(400).json({
                    success: false,
                    message: 'assigned_store must be one of: arcade, dreamcube, toys_merch, all'
                });
            }
            updates.push('assigned_store = ?');
            values.push(assigned_store);
        }

        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        // Add user_id to values
        values.push(id);

        // Update user
        await db.query(
            `UPDATE users SET 
                ${updates.join(', ')}
            WHERE user_id = ?`,
            values
        );

        // Get updated user - CHANGED: removed []
        const updatedUser = await db.query(
            `SELECT 
                user_id,
                username,
                full_name,
                user_type,
                assigned_store,
                is_active,
                created_at
            FROM users 
            WHERE user_id = ?`,
            [id]
        );

        res.json({
            success: true,
            message: 'User updated successfully',
            user: updatedUser[0]
        });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user'
        });
    }
});

// @route   POST /api/auth/change-password/:id
// @desc    Change user password (Admin only)
// @access  Private (Admin only)
router.post('/change-password/:id', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;

        if (!new_password || new_password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password is required and must be at least 6 characters'
            });
        }

        // Check if user exists - CHANGED: removed []
        const existingUsers = await db.query(
            'SELECT * FROM users WHERE user_id = ?',
            [id]
        );

        if (!existingUsers || existingUsers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(new_password, salt);

        // Update password
        await db.query(
            'UPDATE users SET password_hash = ? WHERE user_id = ?',
            [password_hash, id]
        );

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error changing password'
        });
    }
});

module.exports = router;