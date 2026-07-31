CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    key_value VARCHAR(64) NOT NULL UNIQUE,   -- the actual API key string, random per key
    user_id BIGINT NOT NULL,
    algorithm ENUM('token_bucket', 'sliding_window_log', 'sliding_window_counter') NOT NULL DEFAULT 'token_bucket',
    limit_per_window INT NOT NULL,           -- max requests allowed in the window
    window_seconds INT NOT NULL,             -- window length in seconds
    burst_capacity INT DEFAULT NULL,         -- only used by token_bucket; NULL = defaults to limit_per_window
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_key_value (key_value)
);

-- No INSERT statements here on purpose. Real users and real keys get created
-- through the /admin/register and /admin/keys API routes, not seeded fake data.
