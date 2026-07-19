CREATE TABLE `geocache` (
	`query` text PRIMARY KEY NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`bbox` text,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
