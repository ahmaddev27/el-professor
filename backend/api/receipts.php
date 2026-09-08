<?php
require_once '../config.php';
require_once '../cors.php';
require_once '../middleware.php';

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);
$id = $_GET['id'] ?? null;

switch ($method) {
    case 'GET':
        $id ? getReceipt($id) : getReceipts();
        break;
    case 'POST':
        createReceipt($input);
        break;
    case 'PUT':
        updateReceipt($id, $input);
        break;
    case 'DELETE':
        deleteReceipt($id);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getReceipts() {
    $auth = requireAuth();
    $db = getDB();

    $query = 'SELECT * FROM receipts';
    $params = [];

    // Non-admin users can only see their own receipts
    if ($auth['role'] !== 'admin') {
        $query .= ' WHERE user_id = ? OR created_by = ?';
        $params = [$auth['user_id'], $auth['email']];
    }

    $query .= ' ORDER BY date DESC, created_at DESC';

    $stmt = $db->prepare($query);
    $stmt->execute($params);
    $receipts = $stmt->fetchAll();

    sendJSON($receipts);
}

function getReceipt($id) {
    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM receipts WHERE id = ?');
    $stmt->execute([$id]);
    $receipt = $stmt->fetch();

    if (!$receipt) {
        sendError('Receipt not found', 404);
    }

    // Check permissions
    if ($auth['role'] !== 'admin' &&
        $receipt['user_id'] !== $auth['user_id'] &&
        $receipt['created_by'] !== $auth['email']) {
        sendError('Forbidden', 403);
    }

    sendJSON($receipt);
}

function createReceipt($input) {
    $auth = requireRole(['admin', 'creator']);

    $required = ['receipt_number', 'date', 'description', 'driver_name'];
    foreach ($required as $field) {
        if (!isset($input[$field])) {
            sendError("$field is required", 400);
        }
    }

    $db = getDB();
    $id = generateUUID();

    $stmt = $db->prepare('INSERT INTO receipts
                          (id, user_id, created_by, receipt_number, date, description, driver_name,
                           expense, payment_method, postal_code, city)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $auth['user_id'],
        $auth['email'],
        $input['receipt_number'],
        $input['date'],
        $input['description'],
        $input['driver_name'],
        $input['expense'] ?? 0,
        $input['payment_method'] ?? 'bar',
        $input['postal_code'] ?? null,
        $input['city'] ?? null
    ]);

    $stmt = $db->prepare('SELECT * FROM receipts WHERE id = ?');
    $stmt->execute([$id]);
    $receipt = $stmt->fetch();

    sendJSON($receipt, 201);
}

function updateReceipt($id, $input) {
    if (!$id) sendError('Receipt ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM receipts WHERE id = ?');
    $stmt->execute([$id]);
    $receipt = $stmt->fetch();

    if (!$receipt) {
        sendError('Receipt not found', 404);
    }

    // Check permissions
    if (!canEdit($receipt['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $updates = [];
    $params = [];

    $allowed = ['receipt_number', 'date', 'description', 'driver_name', 'expense',
                'payment_method', 'postal_code', 'city'];

    foreach ($allowed as $field) {
        if (isset($input[$field])) {
            $updates[] = "$field = ?";
            $params[] = $input[$field];
        }
    }

    if (empty($updates)) {
        sendError('No fields to update', 400);
    }

    $params[] = $id;
    $query = 'UPDATE receipts SET ' . implode(', ', $updates) . ' WHERE id = ?';
    $stmt = $db->prepare($query);
    $stmt->execute($params);

    $stmt = $db->prepare('SELECT * FROM receipts WHERE id = ?');
    $stmt->execute([$id]);
    $receipt = $stmt->fetch();

    sendJSON($receipt);
}

function deleteReceipt($id) {
    if (!$id) sendError('Receipt ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM receipts WHERE id = ?');
    $stmt->execute([$id]);
    $receipt = $stmt->fetch();

    if (!$receipt) {
        sendError('Receipt not found', 404);
    }

    // Check permissions
    if (!canDelete($receipt['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $stmt = $db->prepare('DELETE FROM receipts WHERE id = ?');
    $stmt->execute([$id]);

    sendJSON(['message' => 'Receipt deleted successfully']);
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
