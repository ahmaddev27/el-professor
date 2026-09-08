<?php
require_once '../config.php';
require_once '../cors.php';
require_once '../middleware.php';

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);
$id = $_GET['id'] ?? null;

switch ($method) {
    case 'GET':
        $id ? getIncome($id) : getIncomes();
        break;
    case 'POST':
        createIncome($input);
        break;
    case 'PUT':
        updateIncome($id, $input);
        break;
    case 'DELETE':
        deleteIncome($id);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getIncomes() {
    $auth = requireAuth();
    $db = getDB();

    $query = 'SELECT * FROM income ORDER BY date DESC, created_at DESC';
    $stmt = $db->prepare($query);
    $stmt->execute();
    $incomes = $stmt->fetchAll();

    sendJSON($incomes);
}

function getIncome($id) {
    requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM income WHERE id = ?');
    $stmt->execute([$id]);
    $income = $stmt->fetch();

    if (!$income) {
        sendError('Income not found', 404);
    }

    sendJSON($income);
}

function createIncome($input) {
    $auth = requireRole(['admin', 'creator']);

    $required = ['description', 'amount', 'type', 'driver_name'];
    foreach ($required as $field) {
        if (!isset($input[$field])) {
            sendError("$field is required", 400);
        }
    }

    $db = getDB();
    $id = generateUUID();

    $stmt = $db->prepare('INSERT INTO income
                          (id, created_by, description, amount, type, driver_name, date, week_number)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $auth['profile_id'],
        $input['description'],
        $input['amount'],
        $input['type'],
        $input['driver_name'],
        $input['date'] ?? date('Y-m-d'),
        $input['week_number'] ?? 1
    ]);

    $stmt = $db->prepare('SELECT * FROM income WHERE id = ?');
    $stmt->execute([$id]);
    $income = $stmt->fetch();

    sendJSON($income, 201);
}

function updateIncome($id, $input) {
    if (!$id) sendError('Income ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM income WHERE id = ?');
    $stmt->execute([$id]);
    $income = $stmt->fetch();

    if (!$income) {
        sendError('Income not found', 404);
    }

    // Check permissions
    if (!canEdit($income['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $updates = [];
    $params = [];

    $allowed = ['description', 'amount', 'type', 'driver_name', 'date', 'week_number'];

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
    $query = 'UPDATE income SET ' . implode(', ', $updates) . ' WHERE id = ?';
    $stmt = $db->prepare($query);
    $stmt->execute($params);

    $stmt = $db->prepare('SELECT * FROM income WHERE id = ?');
    $stmt->execute([$id]);
    $income = $stmt->fetch();

    sendJSON($income);
}

function deleteIncome($id) {
    if (!$id) sendError('Income ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM income WHERE id = ?');
    $stmt->execute([$id]);
    $income = $stmt->fetch();

    if (!$income) {
        sendError('Income not found', 404);
    }

    // Check permissions
    if (!canDelete($income['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $stmt = $db->prepare('DELETE FROM income WHERE id = ?');
    $stmt->execute([$id]);

    sendJSON(['message' => 'Income deleted successfully']);
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
