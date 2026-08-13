"""
Token verification for the School Scraper API.

Signing in happens in the auth service; this module only checks the tokens it
issues, using the shared JWT_SECRET. There is deliberately no user list and no
way to mint a token here — that would be a second set of credentials to keep
safe, and a second way into the toolbox.
"""

import jwt
import os
from functools import wraps
from flask import request, jsonify

# JWT Secret Key (from environment variable, REQUIRED in production)
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    raise ValueError("JWT_SECRET environment variable must be set. This is required for security.")
JWT_ALGORITHM = "HS256"

def verify_token(token: str) -> dict:
    """Verify JWT token and return payload if valid"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def require_auth(f):
    """Decorator to require authentication for API endpoints"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Skip auth for OPTIONS requests (CORS preflight)
        if request.method == "OPTIONS":
            return f(*args, **kwargs)

        # Get token from Authorization header
        auth_header = request.headers.get("Authorization")
        if not auth_header:
            return jsonify({
                "status": "error",
                "error": "Authorization header missing"
            }), 401

        # Extract token from "Bearer <token>" format
        try:
            token = auth_header.split(" ")[1] if " " in auth_header else auth_header
        except IndexError:
            return jsonify({
                "status": "error",
                "error": "Invalid authorization header format"
            }), 401

        # Verify token
        payload = verify_token(token)
        if not payload:
            return jsonify({
                "status": "error",
                "error": "Invalid or expired token"
            }), 401

        # Add user info to request context
        request.current_user = payload.get("username")

        return f(*args, **kwargs)

    return decorated_function
