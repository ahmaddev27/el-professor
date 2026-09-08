<?php
// Database configuration for Hostinger MySQL
// IMPORTANT: Update these values with your actual Hostinger database credentials

define('DB_HOST', 'localhost'); // Usually 'localhost' for shared hosting
define('DB_NAME', 'your_database_name'); // Your MySQL database name from Hostinger
define('DB_USER', 'your_database_user'); // Your MySQL username from Hostinger
define('DB_PASS', 'your_database_password'); // Your MySQL password from Hostinger
define('DB_CHARSET', 'utf8mb4');

// Session configuration
define('SESSION_LIFETIME', 1200); // 20 minutes in seconds
define('SESSION_NAME', 'receipt_app_session');

// CORS configuration - Update with your actual frontend URL
define('ALLOWED_ORIGIN', 'http://localhost:5173'); // Change to your production URL

// Security
define('JWT_SECRET', 'your-secret-key-change-this'); // Generate a secure random string

// Timezone
date_default_timezone_set('Europe/Berlin');

// Error reporting (disable in production)
error_reporting(E_ALL);
ini_set('display_errors', 1);

// Database connection function
function getDB() {
    static $pdo = null;

    if ($pdo === null) {
        try {
            $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=" . DB_CHARSET;
            $options = [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ];
            $pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
        } catch (PDOException $e) {
            http_response_code(500);
            echo json_encode(['error' => 'Database connection failed']);
            exit;
        }
    }

    return $pdo;
}

// Helper function to send JSON response
function sendJSON($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}

// Helper function to send error response
function sendError($message, $status = 400) {
    sendJSON(['error' => $message], $status);
}
