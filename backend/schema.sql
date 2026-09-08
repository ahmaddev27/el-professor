-- Receipt Management System - MySQL Schema
-- Complete database schema for Hostinger MySQL hosting

-- Drop existing tables if they exist (in reverse order of dependencies)
DROP TABLE IF EXISTS `cash_transactions`;
DROP TABLE IF EXISTS `salaries`;
DROP TABLE IF EXISTS `income`;
DROP TABLE IF EXISTS `fixed_costs`;
DROP TABLE IF EXISTS `receipts`;
DROP TABLE IF EXISTS `drivers`;
DROP TABLE IF EXISTS `user_sessions`;
DROP TABLE IF EXISTS `user_profiles`;
DROP TABLE IF EXISTS `users`;

-- Users table (replaces auth.users from Supabase)
CREATE TABLE `users` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User profiles table
CREATE TABLE `user_profiles` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` VARCHAR(36) NOT NULL UNIQUE,
  `email` VARCHAR(255) NOT NULL,
  `full_name` VARCHAR(255) DEFAULT NULL,
  `role` ENUM('admin', 'creator', 'viewer') NOT NULL DEFAULT 'viewer',
  `metadata` JSON DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User sessions table
CREATE TABLE `user_sessions` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` VARCHAR(36) NOT NULL,
  `session_token` VARCHAR(255) NOT NULL UNIQUE,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `user_agent` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `last_active_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_active` BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_session_token` (`session_token`),
  INDEX `idx_is_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Drivers table
CREATE TABLE `drivers` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `user_id` VARCHAR(36) DEFAULT NULL,
  `created_by` VARCHAR(255) DEFAULT NULL,
  `name` VARCHAR(255) NOT NULL,
  `status` ENUM('active', 'inactive') DEFAULT 'active',
  `salary_ratio` DECIMAL(10, 4) DEFAULT 0.5000 CHECK (`salary_ratio` >= 0 AND `salary_ratio` <= 1),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Receipts table
CREATE TABLE `receipts` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `user_id` VARCHAR(36) DEFAULT NULL,
  `created_by` VARCHAR(255) DEFAULT NULL,
  `receipt_number` VARCHAR(100) NOT NULL,
  `date` DATE NOT NULL,
  `description` TEXT NOT NULL,
  `driver_name` VARCHAR(255) NOT NULL,
  `expense` DECIMAL(10, 2) DEFAULT 0,
  `payment_method` ENUM('bar', 'uberweisung') DEFAULT 'bar',
  `postal_code` VARCHAR(20) DEFAULT NULL,
  `city` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_date` (`date`),
  INDEX `idx_driver_name` (`driver_name`),
  INDEX `idx_payment_method` (`payment_method`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fixed costs table
CREATE TABLE `fixed_costs` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `created_by` VARCHAR(36) DEFAULT NULL,
  `description` TEXT NOT NULL,
  `amount` DECIMAL(10, 2) DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Income table
CREATE TABLE `income` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `created_by` BIGINT DEFAULT NULL,
  `description` TEXT NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL CHECK (`amount` >= 0),
  `type` ENUM('bargeld', 'umsatz', 'trinkgeld') NOT NULL,
  `driver_name` VARCHAR(255) NOT NULL,
  `date` DATE DEFAULT (CURRENT_DATE),
  `week_number` INT DEFAULT 1,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_date` (`date`),
  INDEX `idx_driver_name` (`driver_name`),
  INDEX `idx_type` (`type`),
  INDEX `idx_week_number` (`week_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Salaries table
CREATE TABLE `salaries` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `driver_id` VARCHAR(36) NOT NULL,
  `created_by` VARCHAR(36) NOT NULL,
  `period_start` DATE NOT NULL,
  `period_end` DATE NOT NULL,
  `calc_revenue` DECIMAL(10, 2) DEFAULT 0,
  `calc_tips` DECIMAL(10, 2) DEFAULT 0,
  `amount_due` DECIMAL(10, 2) DEFAULT 0,
  `netto_salary` DECIMAL(10, 2) DEFAULT NULL,
  `status` ENUM('paid', 'unpaid') DEFAULT 'unpaid',
  `paid_at` TIMESTAMP DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON DELETE CASCADE,
  INDEX `idx_driver_id` (`driver_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_period` (`period_start`, `period_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cash transactions table
CREATE TABLE `cash_transactions` (
  `id` VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  `created_by` VARCHAR(255) NOT NULL,
  `transaction_type` ENUM('deposit', 'payment') NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL CHECK (`amount` > 0),
  `description` TEXT NOT NULL,
  `date` DATE DEFAULT (CURRENT_DATE),
  `reference_id` VARCHAR(36) DEFAULT NULL,
  `reference_type` VARCHAR(50) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_date` (`date`),
  INDEX `idx_transaction_type` (`transaction_type`),
  INDEX `idx_reference` (`reference_id`, `reference_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default admin user (password: admin123)
-- Password hash generated using PHP: password_hash('admin123', PASSWORD_BCRYPT)
INSERT INTO `users` (`id`, `email`, `password_hash`) VALUES
('admin-uuid-001', 'admin@example.com', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi');

INSERT INTO `user_profiles` (`user_id`, `email`, `full_name`, `role`) VALUES
('admin-uuid-001', 'admin@example.com', 'System Administrator', 'admin');
