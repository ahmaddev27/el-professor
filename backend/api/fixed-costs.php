<?php
require_once '../config.php';
require_once '../cors.php';
require_once '../middleware.php';

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);
$id = $_GET['id'] ?? null;

switch ($method) {
    case 'GET':
        getFixedCosts();
        break;
    case 'POST':
        createFixedCost($input);
        break;
    case 'PUT':
        updateFixedCost($id, $input);
        break;
    case 'DELETE':
        deleteFixedCost($id);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getFixedCosts() {
    requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM fixed_costs ORDER BY created_at DESC');
    $stmt->execute();
    $costs = $stmt->fetchAll();

    sendJSON($costs);
}

function createFixedCost($input) {
    $auth = requireRole(['admin', 'creator']);

    if (!isset($input['description']) || !isset($input['amount'])) {
        sendError('Description and amount are required', 400);
    }

    $db = getDB();
    $id = generateUUID();

    $stmt = $db->prepare('INSERT INTO fixed_costs (id, created_by, description, amount)
                          VALUES (?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $auth['user_id'],
        $input['description'],
        $input['amount']
    ]);

    $stmt = $db->prepare('SELECT * FROM fixed_costs WHERE id = ?');
    $stmt->execute([$id]);
    $cost = $stmt->fetch();

    sendJSON($cost, 201);
}

function updateFixedCost($id, $input) {
    if (!$id) sendError('Cost ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM fixed_costs WHERE id = ?');
    $stmt->execute([$id]);
    $cost = $stmt->fetch();

    if (!$cost) {
        sendError('Cost not found', 404);
    }

    if (!canEdit($cost['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $updates = [];
    $params = [];

    if (isset($input['description'])) {
        $updates[] = 'description = ?';
        $params[] = $input['description'];
    }
    if (isset($input['amount'])) {
        $updates[] = 'amount = ?';
        $params[] = $input['amount'];
    }

    if (empty($updates)) {
        sendError('No fields to update', 400);
    }

    $params[] = $id;
    $query = 'UPDATE fixed_costs SET ' . implode(', ', $updates) . ' WHERE id = ?';
    $stmt = $db->prepare($query);
    $stmt->execute($params);

    $stmt = $db->prepare('SELECT * FROM fixed_costs WHERE id = ?');
    $stmt->execute([$id]);
    $cost = $stmt->fetch();

    sendJSON($cost);
}

function deleteFixedCost($id) {
    if (!$id) sendError('Cost ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM fixed_costs WHERE id = ?');
    $stmt->execute([$id]);
    $cost = $stmt->fetch();

    if (!$cost) {
        sendError('Cost not found', 404);
    }

    if (!canDelete($cost['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $stmt = $db->prepare('DELETE FROM fixed_costs WHERE id = ?');
    $stmt->execute([$id]);

    sendJSON(['message' => 'Cost deleted successfully']);
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
