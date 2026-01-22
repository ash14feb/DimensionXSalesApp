const jwt = require('jsonwebtoken');
const db = require('../utils/database');

const authMiddleware = async (req, res, next) => {
    try {
        console.log('🔐 Auth Middleware - Starting...');

        // Get token from header
        const token = req.header('Authorization')?.replace('Bearer ', '');
        console.log('Token present:', !!token);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No authentication token, access denied'
            });
        }

        // Verify token
        console.log('Verifying token...');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('Token decoded:', { userId: decoded.userId, userType: decoded.userType });

        // Check if user still exists - FIXED: removed [] from db.query()
        const users = await db.query(
            'SELECT user_id, username, full_name, user_type, assigned_store FROM users WHERE user_id = ? AND is_active = 1',
            [decoded.userId]
        );

        console.log('Users found in DB:', users ? users.length : 0);

        if (!users || users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive'
            });
        }

        // Add user to request
        req.user = users[0];
        console.log('✅ Authentication successful for user:', req.user.username);
        next();
    } catch (error) {
        console.error('Auth middleware error:', error.name, '-', error.message);

        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expired'
            });
        }
        console.error('Full error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication error'
        });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        console.log('🔑 Authorization check - User:', req.user?.username, 'Type:', req.user?.user_type);

        if (!req.user) {
            console.log('❌ No user in request');
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        console.log('Allowed roles:', roles);

        if (!roles.includes(req.user.user_type)) {
            console.log('❌ User not authorized for this action');
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action'
            });
        }

        console.log('✅ Authorization granted');
        next();
    };
};

module.exports = { authMiddleware, authorize };