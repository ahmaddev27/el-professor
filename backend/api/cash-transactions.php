<?php
require_once '../config.php';
require_once '../cors.php';
require_once '../middleware.php';

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);
$id = $_GET['id'] ?? null;

switch ($method) {
    case 'GET':
        getCashTransactions();
        break;
    case 'POST':
        createCashTransaction($input);
        break;
    case 'DELETE':
        deleteCashTransaction($id);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getCashTransactions() {
    requireAuth();
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM cash_transactions ORDER BY date DESC, created_at DESC');
    $stmt->execute();
    $transactions = $stmt->fetchAll();

    sendJSON($transactions);
}

function createCashTransaction($input) {
    $auth = requireRole(['admin', 'creator']);

    $required = ['transaction_type', 'amount', 'description'];
    foreach ($required as $field) {
        if (!isset($input[$field])) {
            sendError("$field is required", 400);
        }
    }

    $db = getDB();
    $id = generateUUID();

    $stmt = $db->prepare('INSERT INTO cash_transactions
                          (id, created_by, transaction_type, amount, description, date, reference_id, reference_type)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $auth['email'],
        $input['transaction_type'],
        $input['amount'],
        $input['description'],
        $input['date'] ?? date('Y-m-d'),
        $input['reference_id'] ?? null,
        $input['reference_type'] ?? null
    ]);

    $stmt = $db->prepare('SELECT * FROM cash_transactions WHERE id = ?');
    $stmt->execute([$id]);
    $transaction = $stmt->fetch();

    sendJSON($transaction, 201);
}

function deleteCashTransaction($id) {
    if (!$id) sendError('Transaction ID required', 400);

    requireRole(['admin']);
    $db = getDB();

    $stmt = $db->prepare('SELECT * FROM cash_transactions WHERE id = ?');
    $stmt->execute([$id]);
    $transaction = $stmt->fetch();

    if (!$transaction) {
        sendError('Transaction not found', 404);
    }

    $stmt = $db->prepare('DELETE FROM cash_transactions WHERE id = ?');
    $stmt->execute([$id]);

    sendJSON(['message' => 'Transaction deleted successfully']);
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
