CREATE TABLE `conversation_collaborators` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'view' NOT NULL,
	`invited_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_collaborators_pair_idx` ON `conversation_collaborators` (`conversation_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `conversation_collaborators_conversation_idx` ON `conversation_collaborators` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `conversation_collaborators_user_idx` ON `conversation_collaborators` (`user_id`);