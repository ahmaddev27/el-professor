<?php
require_once '../config.php';
require_once '../cors.php';
require_once '../middleware.php';

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);
$id = $_GET['id'] ?? null;

switch ($method) {
    case 'GET':
        getSalaries();
        break;
    case 'POST':
        createSalary($input);
        break;
    case 'PUT':
        updateSalary($id, $input);
        break;
    case 'DELETE':
        deleteSalary($id);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getSalaries() {
    requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT s.*, d.name as driver_name
                          FROM salaries s
                          LEFT JOIN drivers d ON s.driver_id = d.id
                          ORDER BY s.created_at DESC');
    $stmt->execute();
    $salaries = $stmt->fetchAll();

    sendJSON($salaries);
}

function createSalary($input) {
    $auth = requireRole(['admin', 'creator']);

    $required = ['driver_id', 'period_start', 'period_end', 'calc_revenue', 'calc_tips', 'amount_due'];
    foreach ($required as $field) {
        if (!isset($input[$field])) {
            sendError("$field is required", 400);
        }
    }

    $db = getDB();
    $id = generateUUID();

    $stmt = $db->prepare('INSERT INTO salaries
                          (id, driver_id, created_by, period_start, period_end, calc_revenue,
                           calc_tips, amount_due, netto_salary, status, notes)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $input['driver_id'],
        $auth['user_id'],
        $input['period_start'],
        $input['period_end'],
        $input['calc_revenue'],
        $input['calc_tips'],
        $input['amount_due'],
        $input['netto_salary'] ?? null,
        $input['status'] ?? 'unpaid',
        $input['notes'] ?? null
    ]);

    $stmt = $db->prepare('SELECT s.*, d.name as driver_name
                          FROM salaries s
                          LEFT JOIN drivers d ON s.driver_id = d.id
                          WHERE s.id = ?');
    $stmt->execute([$id]);
    $salary = $stmt->fetch();

    sendJSON($salary, 201);
}

function updateSalary($id, $input) {
    if (!$id) sendError('Salary ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM salaries WHERE id = ?');
    $stmt->execute([$id]);
    $salary = $stmt->fetch();

    if (!$salary) {
        sendError('Salary not found', 404);
    }

    if (!canEdit($salary['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $updates = [];
    $params = [];

    $allowed = ['period_start', 'period_end', 'calc_revenue', 'calc_tips', 'amount_due',
                'netto_salary', 'status', 'paid_at', 'notes'];

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
    $query = 'UPDATE salaries SET ' . implode(', ', $updates) . ' WHERE id = ?';
    $stmt = $db->prepare($query);
    $stmt->execute($params);

    $stmt = $db->prepare('SELECT s.*, d.name as driver_name
                          FROM salaries s
                          LEFT JOIN drivers d ON s.driver_id = d.id
                          WHERE s.id = ?');
    $stmt->execute([$id]);
    $salary = $stmt->fetch();

    sendJSON($salary);
}

function deleteSalary($id) {
    if (!$id) sendError('Salary ID required', 400);

    $auth = requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM salaries WHERE id = ?');
    $stmt->execute([$id]);
    $salary = $stmt->fetch();

    if (!$salary) {
        sendError('Salary not found', 404);
    }

    if (!canDelete($salary['created_by'], $auth)) {
        sendError('Forbidden', 403);
    }

    $stmt = $db->prepare('DELETE FROM salaries WHERE id = ?');
    $stmt->execute([$id]);

    sendJSON(['message' => 'Salary deleted successfully']);
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
