<?php
require_once '../config.php';
require_once '../cors.php';
require_once '../middleware.php';

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);
$id = $_GET['id'] ?? null;

switch ($method) {
    case 'GET':
        $id ? getDriver($id) : getDrivers();
        break;
    case 'POST':
        createDriver($input);
        break;
    case 'PUT':
        updateDriver($id, $input);
        break;
    case 'DELETE':
        deleteDriver($id);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getDrivers() {
    $auth = requireAuth();
    $db = getDB();

    $query = 'SELECT * FROM drivers';
    $params = [];

    // Non-admin users can only see their own drivers
    if ($auth['role'] !== 'admin') {
        $query .= ' WHERE user_id = ? OR created_by = ?';
        $params = [$auth['user_id'], $auth['email']];
    }

    $query .= ' ORDER BY created_at DESC';

    $stmt = $db->prepare($query);
    $stmt->execute($params);
    $drivers = $stmt->fetchAll();

    sendJSON($drivers);
}

function getDriver($id) {
    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM drivers WHERE id = ?');
    $stmt->execute([$id]);
    $driver = $stmt->fetch();

    if (!$driver) {
        sendError('Driver not found', 404);
    }

    // Check permissions
    if ($auth['role'] !== 'admin' &&
        $driver['user_id'] !== $auth['user_id'] &&
        $driver['created_by'] !== $auth['email']) {
        sendError('Forbidden', 403);
    }

    sendJSON($driver);
}

function createDriver($input) {
    $auth = requireRole(['admin', 'creator']);

    if (!isset($input['name'])) {
        sendError('Name is required', 400);
    }

    $db = getDB();
    $id = generateUUID();

    $stmt = $db->prepare('INSERT INTO drivers (id, user_id, created_by, name, status, salary_ratio)
                          VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $auth['user_id'],
        $auth['email'],
        $input['name'],
        $input['status'] ?? 'active',
        $input['salary_ratio'] ?? 0.5000
    ]);

    $stmt = $db->prepare('SELECT * FROM drivers WHERE id = ?');
    $stmt->execute([$id]);
    $driver = $stmt->fetch();

    sendJSON($driver, 201);
}

function updateDriver($id, $input) {
    if (!$id) sendError('Driver ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM drivers WHERE id = ?');
    $stmt->execute([$id]);
    $driver = $stmt->fetch();

    if (!$driver) {
        sendError('Driver not found', 404);
    }

    // Check permissions
    if (!canEdit($driver['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $updates = [];
    $params = [];

    if (isset($input['name'])) {
        $updates[] = 'name = ?';
        $params[] = $input['name'];
    }
    if (isset($input['status'])) {
        $updates[] = 'status = ?';
        $params[] = $input['status'];
    }
    if (isset($input['salary_ratio'])) {
        $updates[] = 'salary_ratio = ?';
        $params[] = $input['salary_ratio'];
    }

    if (empty($updates)) {
        sendError('No fields to update', 400);
    }

    $params[] = $id;
    $query = 'UPDATE drivers SET ' . implode(', ', $updates) . ' WHERE id = ?';
    $stmt = $db->prepare($query);
    $stmt->execute($params);

    $stmt = $db->prepare('SELECT * FROM drivers WHERE id = ?');
    $stmt->execute([$id]);
    $driver = $stmt->fetch();

    sendJSON($driver);
}

function deleteDriver($id) {
    if (!$id) sendError('Driver ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM drivers WHERE id = ?');
    $stmt->execute([$id]);
    $driver = $stmt->fetch();

    if (!$driver) {
        sendError('Driver not found', 404);
    }

    // Check permissions
    if (!canDelete($driver['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $stmt = $db->prepare('DELETE FROM drivers WHERE id = ?');
    $stmt->execute([$id]);

    sendJSON(['message' => 'Driver deleted successfully']);
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
