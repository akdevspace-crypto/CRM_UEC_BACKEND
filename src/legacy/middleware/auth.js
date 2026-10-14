const jwt = require('jsonwebtoken');

/**
 * Express Authentication Middleware for Legacy Routes
 * Enforces valid Bearer JWT tokens signed with the application JWT_SECRET.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized: Authentication token required' });
  }

  let token = authHeader;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Token missing' });
  }

  const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
  try {
    const payload = jwt.verify(token, secret);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

/**
 * Role-Based Access Control (RBAC) middleware for Express routes.
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
