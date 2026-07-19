ALTER TABLE `invite_tokens` ADD `model_allowlist` text;--> statement-breakpoint
ALTER TABLE `invite_tokens` ADD `token_budget` integer;--> statement-breakpoint
ALTER TABLE `invite_tokens` ADD `max_concurrency` integer;--> statement-breakpoint
ALTER TABLE `invite_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `invite_tokens` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `model_allowlist` text;--> statement-breakpoint
ALTER TABLE `users` ADD `token_budget` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `max_concurrency` integer;