<?php
require_once 'config.php';
require_once 'cors.php';

session_name(SESSION_NAME);
session_start();

// Get request method and data
$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);

// Route handling
$path = $_GET['action'] ?? '';

switch ($path) {
    case 'login':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleLogin($input);
        break;

    case 'logout':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleLogout();
        break;

    case 'session':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleGetSession();
        break;

    case 'register':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleRegister($input);
        break;

    default:
        sendError('Invalid action', 404);
}

function handleLogin($input) {
    if (!isset($input['email']) || !isset($input['password'])) {
        sendError('Email and password required', 400);
    }

    $email = filter_var($input['email'], FILTER_SANITIZE_EMAIL);
    $password = $input['password'];

    $db = getDB();
    $stmt = $db->prepare('SELECT u.id, u.email, u.password_hash, p.id as profile_id, p.full_name, p.role
                          FROM users u
                          LEFT JOIN user_profiles p ON u.id = p.user_id
                          WHERE u.email = ?');
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        sendError('Invalid email or password', 401);
    }

    // Create session
    session_regenerate_id(true);
    $_SESSION['user_id'] = $user['id'];
    $_SESSION['email'] = $user['email'];
    $_SESSION['profile_id'] = $user['profile_id'];
    $_SESSION['role'] = $user['role'];
    $_SESSION['full_name'] = $user['full_name'];
    $_SESSION['last_activity'] = time();

    // Create session record
    $sessionToken = bin2hex(random_bytes(32));
    $ipAddress = $_SERVER['REMOTE_ADDR'] ?? null;
    $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? null;

    $stmt = $db->prepare('INSERT INTO user_sessions (user_id, session_token, ip_address, user_agent)
                          VALUES (?, ?, ?, ?)');
    $stmt->execute([$user['id'], $sessionToken, $ipAddress, $userAgent]);

    sendJSON([
        'user' => [
            'id' => $user['id'],
            'email' => $user['email']
        ],
        'profile' => [
            'id' => $user['profile_id'],
            'user_id' => $user['id'],
            'email' => $user['email'],
            'full_name' => $user['full_name'],
            'role' => $user['role']
        ],
        'session' => [
            'access_token' => session_id()
        ]
    ]);
}

function handleLogout() {
    if (isset($_SESSION['user_id'])) {
        $db = getDB();
        $stmt = $db->prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?');
        $stmt->execute([$_SESSION['user_id']]);
    }

    session_destroy();
    sendJSON(['message' => 'Logged out successfully']);
}

function handleGetSession() {
    // Check session timeout
    if (isset($_SESSION['last_activity']) &&
        (time() - $_SESSION['last_activity']) > SESSION_LIFETIME) {
        session_destroy();
        sendJSON(['user' => null, 'profile' => null, 'session' => null]);
    }

    $_SESSION['last_activity'] = time();

    if (!isset($_SESSION['user_id'])) {
        sendJSON(['user' => null, 'profile' => null, 'session' => null]);
    }

    sendJSON([
        'user' => [
            'id' => $_SESSION['user_id'],
            'email' => $_SESSION['email']
        ],
        'profile' => [
            'id' => $_SESSION['profile_id'],
            'user_id' => $_SESSION['user_id'],
            'email' => $_SESSION['email'],
            'full_name' => $_SESSION['full_name'],
            'role' => $_SESSION['role']
        ],
        'session' => [
            'access_token' => session_id()
        ]
    ]);
}

function handleRegister($input) {
    if (!isset($input['email']) || !isset($input['password'])) {
        sendError('Email and password required', 400);
    }

    $email = filter_var($input['email'], FILTER_SANITIZE_EMAIL);
    $password = $input['password'];
    $fullName = $input['fullName'] ?? '';

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        sendError('Invalid email format', 400);
    }

    if (strlen($password) < 6) {
        sendError('Password must be at least 6 characters', 400);
    }

    $db = getDB();

    // Check if user exists
    $stmt = $db->prepare('SELECT id FROM users WHERE email = ?');
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        sendError('Email already registered', 400);
    }

    // Create user
    $userId = generateUUID();
    $passwordHash = password_hash($password, PASSWORD_BCRYPT);

    $db->beginTransaction();

    try {
        $stmt = $db->prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)');
        $stmt->execute([$userId, $email, $passwordHash]);

        $stmt = $db->prepare('INSERT INTO user_profiles (user_id, email, full_name, role) VALUES (?, ?, ?, ?)');
        $stmt->execute([$userId, $email, $fullName, 'viewer']);

        $db->commit();

        sendJSON(['message' => 'User registered successfully'], 201);
    } catch (Exception $e) {
        $db->rollBack();
        sendError('Registration failed', 500);
    }
}

function generateUUID() {
    return sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff), mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000,
        mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
    );
}
