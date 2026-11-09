-- 影荐 · MySQL 建表脚本（服务启动时会自动执行本文件）
-- 直接导入：先 CREATE DATABASE / USE 目标库，再执行本文件，或由 db.js 自动建库后执行。

CREATE TABLE IF NOT EXISTS `users` (
  `id`         CHAR(36)     NOT NULL,
  `username`   VARCHAR(24)  NOT NULL,
  `salt`       VARCHAR(32)  NOT NULL,
  `hash`       VARCHAR(128) NOT NULL,
  `is_admin`   TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at` VARCHAR(24)  NOT NULL,
  `signature`       VARCHAR(200) NULL,
  `avatar`          VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `comments` (
  `id`         CHAR(36)     NOT NULL,
  `movie_id`   INT          NOT NULL,
  `parent_id`  CHAR(36)     NULL,
  `user_id`    CHAR(36)     NOT NULL,
  `username`   VARCHAR(24)  NOT NULL,
  `text`       VARCHAR(500) NOT NULL,
  `created_at` VARCHAR(24)  NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_comments_movie` (`movie_id`, `created_at`),
  KEY `idx_comments_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ratings` (
  `movie_id` INT      NOT NULL,
  `user_id`  CHAR(36) NOT NULL,
  `rating`   TINYINT  NOT NULL,
  PRIMARY KEY (`movie_id`, `user_id`),
  KEY `idx_ratings_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `favorites` (
  `movie_id`   INT         NOT NULL,
  `user_id`    CHAR(36)    NOT NULL,
  `created_at` VARCHAR(24) NOT NULL,
  PRIMARY KEY (`movie_id`, `user_id`),
  KEY `idx_favorites_user` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `likes` (
  `movie_id`   INT      NOT NULL,
  `comment_id` CHAR(36) NOT NULL,
  `user_id`    CHAR(36) NOT NULL,
  PRIMARY KEY (`comment_id`, `user_id`),
  KEY `idx_likes_movie` (`movie_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notifications` (
  `id`             CHAR(36)     NOT NULL,
  `type`           VARCHAR(10)  NOT NULL,
  `user_id`        CHAR(36)     NOT NULL,
  `actor_id`       CHAR(36)     NOT NULL,
  `actor_username` VARCHAR(24)  NOT NULL,
  `movie_id`       INT          NOT NULL,
  `comment_id`     CHAR(36)     NOT NULL,
  `text`           VARCHAR(500) NOT NULL,
  `parent_text`    VARCHAR(500) NULL,
  `is_read`        TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`     VARCHAR(24)  NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sessions` (
  `token`      CHAR(64)     NOT NULL,
  `user_id`    CHAR(36)     NOT NULL,
  `created_at` VARCHAR(24)  NOT NULL,
  PRIMARY KEY (`token`),
  KEY `idx_sessions_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `movies` (
  `id`          INT           NOT NULL,
  `tmdb_id`     INT           NULL,
  `name`        VARCHAR(200)  NOT NULL,
  `category`    VARCHAR(50)   NOT NULL,
  `year`        INT           NOT NULL,
  `rating`      DECIMAL(3,1)  NOT NULL,
  `director`    VARCHAR(100)  NOT NULL,
  `description` TEXT          NOT NULL,
  `poster`      VARCHAR(500)  NULL,
  `links`       JSON          NULL,
  `updated_at`  VARCHAR(24)   NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
