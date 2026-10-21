CREATE TABLE `usage_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`actual_cost` real NOT NULL,
	`charged_cost` real NOT NULL,
	`credits_before` real NOT NULL,
	`credits_after` real NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_transactions_user_idx` ON `usage_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `usage_transactions_action_idx` ON `usage_transactions` (`action`);--> statement-breakpoint
CREATE INDEX `usage_transactions_created_idx` ON `usage_transactions` (`created_at`);--> statement-breakpoint
CREATE TABLE `user_credits` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	`total_deposited` real DEFAULT 0 NOT NULL,
	`total_used` real DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tx_hash` text NOT NULL,
	`amount_usdc` real NOT NULL,
	`credits_added` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`chain_id` integer DEFAULT 8453 NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	`verified_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_payments_tx_hash_unique` ON `user_payments` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `user_payments_user_idx` ON `user_payments` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_payments_tx_hash_idx` ON `user_payments` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `user_payments_status_idx` ON `user_payments` (`status`);