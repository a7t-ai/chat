PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'guest' NOT NULL,
	`email` text,
	`email_verified_at` integer,
	`access_granted_at` integer,
	`model_allowlist` text,
	`token_budget` integer,
	`max_concurrency` integer,
	`usage_reset_at` integer,
	`theme` text,
	`lang` text,
	`preferences` text,
	`plan` text DEFAULT 'ultra' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "login", "display_name", "role", "email", "email_verified_at", "access_granted_at", "model_allowlist", "token_budget", "max_concurrency", "usage_reset_at", "theme", "lang", "preferences", "plan", "created_at") SELECT "id", "login", "display_name", "role", "email", "email_verified_at", "access_granted_at", "model_allowlist", "token_budget", "max_concurrency", "usage_reset_at", "theme", "lang", "preferences", "plan", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_unique` ON `users` (`login`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);