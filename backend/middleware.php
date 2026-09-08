<?php
// Authentication middleware

function requireAuth() {
    session_name(SESSION_NAME);
    session_start();

    // Check session timeout
    if (isset($_SESSION['last_activity']) &&
        (time() - $_SESSION['last_activity']) > SESSION_LIFETIME) {
        session_destroy();
        sendError('Session expired', 401);
    }

    if (!isset($_SESSION['user_id'])) {
        sendError('Unauthorized', 401);
    }

    $_SESSION['last_activity'] = time();

    return [
        'user_id' => $_SESSION['user_id'],
        'profile_id' => $_SESSION['profile_id'],
        'email' => $_SESSION['email'],
        'role' => $_SESSION['role']
    ];
}

function requireRole($allowedRoles) {
    $auth = requireAuth();

    if (!in_array($auth['role'], $allowedRoles)) {
        sendError('Forbidden - insufficient permissions', 403);
    }

    return $auth;
}

function canEdit($createdBy, $auth) {
    return $auth['role'] === 'admin' || $auth['profile_id'] == $createdBy;
}

function canDelete($createdBy, $auth) {
    return $auth['role'] === 'admin' || $auth['profile_id'] == $createdBy;
}
